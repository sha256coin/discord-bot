// alert-test.js - posts a sample alert to the configured alert channels
// Usage: node alert-test.js [chain|admin]   (no argument: both)
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();
const { sendAlerts } = require("./alerts");

const only = process.argv[2];
if (only && only !== "chain" && only !== "admin") {
  console.error("Usage: node alert-test.js [chain|admin]");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  const hash = "0000000000000023d756e35e1cef8189f2335c6935c5398d021a7f16d85f2b8c";
  const samples = [
    {
      channel: "chain",
      severity: "warning",
      title: "TEST: 3-block reorg",
      reorg: {
        depth: 3,
        forkHeight: 17878,
        oldTip: { height: 17881, hash },
        newTip: { height: 17882, hash },
      },
    },
    { channel: "admin", severity: "warning", title: "TEST: Few peers", text: "This is a test message. Only 2 peer(s) connected (minimum 3)." },
  ];
  await sendAlerts(client, samples.filter((a) => !only || a.channel === only));
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
