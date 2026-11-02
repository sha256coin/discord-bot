// alerts.js
const { EmbedBuilder } = require("discord.js");

const EXPLORER = "https://explorer.sha256coin.eu";
const COLORS = { warning: 0xed4245, ok: 0x57f287 };

// Block hashes start with many zeros, so skip them and keep both ends
const short = (h) => {
  const t = h.replace(/^0+/, "");
  return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-6)}` : t;
};
const blockLink = (h) => `[${short(h)}](${EXPLORER}/block/${h})`;
const fmt = (n) => Number(n).toLocaleString("en-US");

function buildAlertEmbed(a) {
  let description = a.text || "";

  if (a.reorg) {
    const r = a.reorg;
    const fork =
      r.forkHeight === null
        ? `deeper than the ${r.depth} blocks we track`
        : `fork after height ${fmt(r.forkHeight)}`;
    description =
      `**${r.depth}${r.forkHeight === null ? "+" : ""} blocks replaced** (${fork})\n` +
      `Old tip: ${fmt(r.oldTip.height)} ${blockLink(r.oldTip.hash)}\n` +
      `New tip: ${fmt(r.newTip.height)} ${blockLink(r.newTip.hash)}\n` +
      `Exchanges that wait for fewer confirmations than this are exposed.`;
  } else if (a.branch) {
    const t = a.branch;
    description =
      `A ${t.branchlen}-block branch (${t.status}) at height ${fmt(t.height)}, ` +
      `${a.tipHeight - t.height} blocks behind the tip.\nTip \`${short(t.hash)}\``;
  } else if (a.blockHash) {
    description += `\nLast block ${blockLink(a.blockHash)}`;
  }

  return new EmbedBuilder()
    .setColor(COLORS[a.severity] || COLORS.warning)
    .setTitle(`${a.severity === "ok" ? "✅" : "⚠️"} ${a.title}`)
    .setDescription(description)
    .setTimestamp();
}

// "chain" alerts are for the community, "admin" ones for the operators. A
// channel that is not configured just means the alert is only logged.
function channelIdFor(kind) {
  return kind === "admin" ? process.env.ADMIN_CHANNEL_ID : process.env.ALERT_CHANNEL_ID;
}

async function sendAlerts(client, alerts) {
  for (const a of alerts) {
    console.log(`[alert:${a.channel}] ${a.title}${a.text ? " - " + a.text : ""}`);
    const id = channelIdFor(a.channel);
    if (!id) continue;
    try {
      const channel = await client.channels.fetch(id);
      await channel.send({ embeds: [buildAlertEmbed(a)] });
    } catch (err) {
      console.error(`Could not post alert "${a.title}":`, err.message);
    }
  }
}

module.exports = { buildAlertEmbed, sendAlerts };
