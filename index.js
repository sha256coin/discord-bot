// index.js
const { Client, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const cron = require("node-cron");
require("dotenv").config();

const api = require("./explorer");
const rpc = require("./rpc");
const { createMonitor, duration } = require("./monitor");
const { sendAlerts } = require("./alerts");

const monitor = createMonitor({ rpc: rpc.call });

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const GUILD_ID = process.env.GUILD_ID;
const LOGO_URL = "https://sha256coin.eu/s256_logo.png";

//client.once("ready", async () => {
//  console.log(`Logged in as ${client.user.tag}`);
//
//  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  // Create the initial message ONCE
//  const msg = await channel.send("Initializing S256 stats…");

//  console.log("Message ID:", msg.id);
//});

// Format large numbers (supply, difficulty)
function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return "N/A";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + " B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + " M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + " K";
  return n.toString();
}

// Auto-format hashrate (H/s → KH/s → MH/s → GH/s → TH/s → PH/s)
function formatHashrate(hashrate) {
  if (!hashrate || isNaN(hashrate)) return "N/A";

  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;

  while (hashrate >= 1000 && i < units.length - 1) {
    hashrate /= 1000;
    i++;
  }

  return `${hashrate.toFixed(2)} ${units[i]}`;
}

// Auto-format difficulty
function formatDifficulty(diff) {
  if (!diff || isNaN(diff)) return "N/A";

  const units = ["", "K", "M", "G", "T", "P", "E"];
  let i = 0;

  while (diff >= 1000 && i < units.length - 1) {
    diff /= 1000;
    i++;
  }

  return `${diff.toFixed(2)} ${units[i]}`;
}

// Seconds since the last block, counted up from the last node check
function blockAge(h) {
  return h.age + Math.max(0, Math.floor((Date.now() - h.updated) / 1000));
}

// One status sentence for the top of the message; blank until the first check
function healthLine(h) {
  if (!h) return null;
  if (!h.rpc) return "⚠️ **Node status unknown**";
  if (h.stalled) return `⚠️ **No new block for ${duration(blockAge(h))}**`;
  return "✅ **Chain healthy**";
}

// Discord has no tables, so label and value go in an aligned code block
function table(rows) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => label.padEnd(width) + value).join("\n");
}

function healthRows(h) {
  if (!h?.rpc) return [];
  const reorgs = h.reorgs24h ? `${h.reorgs24h} (deepest ${h.deepestReorg24h})` : "None";
  return [
    ["Last block", `${duration(blockAge(h))} ago`],
    ["Peers", String(h.peers)],
    ["Reorgs (24h)", reorgs],
    ["Branches", h.branches ? String(h.branches) : "None"],
  ];
}

// Checks the node and posts any new alerts
async function runMonitor() {
  try {
    const { alerts } = await monitor.check();
    await sendAlerts(client, alerts);
  } catch (err) {
    console.error("Monitor check failed:", err);
  }
}

async function updateServerDescription() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    const results = await Promise.allSettled([
      api.getBlockCount(),
      api.getDifficulty(),
      api.getNetworkHash(),
      api.getMoneySupply(),
      api.getPrice(),
    ]);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`Explorer call ${i} failed:`, r.reason.message);
      }
    });

    const [height, difficulty, hashrate, supply, price] = results.map((r) =>
      r.status === "fulfilled" ? r.value : null
    );

    // Nothing usable from the explorer: keep the previous message as is
    if (results.every((r) => r.status === "rejected")) return;

    const health = monitor.getHealth();
    const priceStr = price?.price ? `${price.price.toFixed(4)}` : "N/A";
    const circulating = formatNumber(Number(supply?.circulatingSupply));
    const diffStr = formatDifficulty(difficulty);
    const hashStr = formatHashrate(hashrate);

const description =
`💠**SHA256Coin Network Stats**
 💰  Price: ${priceStr} $
 📦  Coin Supply: ${circulating} S256
 ⛏   Difficulty: ${diffStr}
 ⚡  Hashrate: ${hashStr}
 🔢  Block Height: ${height ?? "N/A"}`;

const channel = await client.channels.fetch(process.env.CHANNEL_ID);
const message = await channel.messages.fetch(process.env.MESSAGE_ID);

const statsRows = [
  ["Block height", height?.toLocaleString("en-US") ?? "N/A"],
  ["Price", `$${priceStr}`],
  ["Hashrate", hashStr],
  ["Difficulty", diffStr],
  ["Supply", `${circulating} S256`],
];
const healthTable = healthRows(health);
const tables =
  "```\n" +
  [table(statsRows), healthTable.length ? table(healthTable) : null].filter(Boolean).join("\n\n") +
  "\n```";
const embed = new EmbedBuilder()
  .setColor(0xf7931a)
  .setTitle("SHA256Coin Network Stats")
  .setThumbnail(LOGO_URL)
  .setDescription([healthLine(health), tables].filter(Boolean).join("\n"))
  .setFooter({ text: "Updates every 5 minutes" })
  .setTimestamp();

if (process.env.EXPLORER_API) embed.setURL(process.env.EXPLORER_API);

// Discord drops embeds (and rejects the edit) without the Embed Links permission
if (channel.permissionsFor(client.user).has(PermissionFlagsBits.EmbedLinks)) {
  await message.edit({ content: "", embeds: [embed] });
} else {
  console.warn("Missing Embed Links permission in channel, using plain text");
  await message.edit(description);
}
// Discord allows 120 characters for the server description
const guildDescription = [
  "SHA256Coin",
  height != null ? `Block ${height.toLocaleString("en-US")}` : null,
  hashrate ? formatHashrate(hashrate) : null,
  price?.price ? `$${priceStr}` : null,
].filter(Boolean).join(" · ").slice(0, 120);
await guild.edit({ description: guildDescription });

    console.log(`[${new Date().toISOString()}] Updated description:\n${description}`);
  } catch (err) {
    console.error("Failed to update server description:", err);
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await runMonitor();
  await updateServerDescription();

// node checks every 2 minutes, the stats message every 5
  cron.schedule("*/2 * * * *", runMonitor);
  cron.schedule("*/5 * * * *", async () => {
    await updateServerDescription();
  });
});

// Retry the login on network/DNS errors instead of crashing into a pm2 restart loop
async function login() {
  for (let delay = 5000; ; delay = Math.min(delay * 2, 300000)) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (err) {
      console.error(`Login failed (${err.code || err.message}), retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

login();
