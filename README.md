# S256 Discord Bot

A Discord bot for the [SHA256Coin](https://sha256coin.eu) community. It keeps one live stats message up to date and watches the node for problems.

## What it does

- **Stats message:** edits one embed every 5 minutes with block height, price, hashrate, difficulty, supply, time since the last block, peers, reorgs in the last 24 hours and competing branches. The numbers come from the [explorer API](https://explorer.sha256coin.eu) and the node. It also keeps the server description to one short line.
- **Node monitor:** checks the node over local RPC every 2 minutes and posts alerts:
  - **Reorg:** compares the hashes of the last 100 blocks. Reports depth, fork height and both tips. Only reorgs of `REORG_ALERT_DEPTH` blocks or more are posted; smaller ones are logged and counted.
  - **Competing branch:** a `valid-fork` or `valid-headers` branch of at least `BRANCH_ALERT_LEN` blocks near the tip, reported once. The node also lists many old one-block header branches; those are ignored.
  - **Stalled chain:** one alert after `STALL_HOURS`, at most one reminder per hour, and a message when blocks resume.
  - **Node health:** RPC unreachable or fewer than `MIN_PEERS` peers, with a recovery message.

Alerts in `ALERT_CHANNEL_ID` are meant for the community, those in `ADMIN_CHANNEL_ID` for the operators. A channel that is not set means its alerts are only logged.

## Setup

Needs Node.js 22 or newer, a Discord bot token, and a SHA256Coin node with RPC on the same machine.

```
npm install
cp .env.example .env    # then fill it in
npm start
```

The bot needs permission to view, send messages and embed links in the stats channel and in the alert channels. Create the stats message once, and put its channel and message ID in `.env`.

Everything is configured through `.env`, see [.env.example](.env.example). It holds the bot token and the RPC login, so it is ignored by git and must never be committed.

## Testing

```
npm test                       # unit tests for the monitor (fake node, no network)
node alert-test.js admin       # post a sample alert to the admin channel
node alert-test.js chain       # post a sample alert to the community channel
```

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Discord client, the stats message and the schedules |
| `monitor.js` | Reorg, branch, stall and node checks; keeps `state.json` |
| `alerts.js` | Builds and sends the alert embeds |
| `rpc.js` | Minimal node RPC client |
| `explorer.js` | Explorer API client |

## License

MIT, see [LICENSE](LICENSE).
