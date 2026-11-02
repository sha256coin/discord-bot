// monitor.js
// Watches the local node for reorgs, competing branches, a stalled chain and
// node trouble. check() returns the numbers for the stats message and the
// alerts that are new since the last run; state.json keeps what was reported.
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state.json");
const HISTORY = 100; // blocks of height -> hash kept for reorg detection
const DAY_MS = 24 * 3600 * 1000;
const STALL_REMINDER_MS = 3600 * 1000;

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : d);

function configFromEnv(env = process.env) {
  return {
    stallSeconds: num(env.STALL_HOURS, 3) * 3600,
    reorgAlertDepth: num(env.REORG_ALERT_DEPTH, 3),
    branchAlertLen: num(env.BRANCH_ALERT_LEN, 3),
    branchMaxAge: num(env.BRANCH_MAX_AGE_BLOCKS, 100),
    minPeers: num(env.MIN_PEERS, 3),
    rpcFailures: num(env.RPC_FAILURES_BEFORE_ALERT, 2),
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function duration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function createMonitor({ rpc, cfg = configFromEnv(), load = loadState, save = saveState, now = () => Date.now(), log = console.log }) {
  let lastHealth = null;

  async function check() {
    const state = load();
    state.blocks = state.blocks || {};
    state.reorgs = (state.reorgs || []).filter((r) => now() - r.time < DAY_MS);
    state.reportedTips = state.reportedTips || [];
    state.stall = state.stall || { active: false, lastAlert: 0 };
    state.node = state.node || { failures: 0, down: false, lowPeers: false };
    const alerts = [];

    let info;
    let net;
    try {
      [info, net] = await Promise.all([rpc("getblockchaininfo"), rpc("getnetworkinfo")]);
    } catch (err) {
      state.node.failures++;
      log(`RPC unreachable (${state.node.failures}): ${err.message}`);
      if (state.node.failures >= cfg.rpcFailures && !state.node.down) {
        state.node.down = true;
        alerts.push({
          channel: "admin",
          severity: "warning",
          title: "Node unreachable",
          text: `The node RPC has failed ${state.node.failures} checks in a row: ${err.message}`,
        });
      }
      save(state);
      lastHealth = { rpc: false, updated: now() };
      return { health: lastHealth, alerts };
    }

    if (state.node.down) {
      alerts.push({ channel: "admin", severity: "ok", title: "Node reachable again", text: "The node RPC answers again." });
    }
    state.node.failures = 0;
    state.node.down = false;

    const tipHeight = info.blocks;
    const tipHash = info.bestblockhash;

    // 1. Reorg: compare the stored hashes with what the node has now.
    const syncing = info.initialblockdownload;
    const stored = Object.keys(state.blocks).map(Number).sort((a, b) => b - a);
    let forkHeight = null;
    if (!syncing && stored.length) {
      const storedTip = stored[0];
      for (const h of stored) {
        if (h > tipHeight) continue; // the chain is shorter than before
        const hash = h === tipHeight ? tipHash : await rpc("getblockhash", [h]);
        if (hash === state.blocks[h]) {
          forkHeight = h;
          break;
        }
      }
      if (forkHeight !== storedTip) {
        const depth = storedTip - (forkHeight ?? stored[stored.length - 1] - 1);
        const reorg = {
          time: now(),
          depth,
          forkHeight,
          oldTip: { height: storedTip, hash: state.blocks[storedTip] },
          newTip: { height: tipHeight, hash: tipHash },
        };
        state.reorgs.push(reorg);
        log(`Reorg: ${depth} block(s) replaced after height ${forkHeight ?? "?"}, ${reorg.oldTip.hash} -> ${tipHash}`);
        if (depth >= cfg.reorgAlertDepth) {
          alerts.push({ channel: "chain", severity: "warning", title: `${depth}-block reorg`, reorg });
        }
      }
    }

    // Rebuild the history: keep what still matches, fetch what is new.
    const blocks = {};
    for (let h = Math.max(0, tipHeight - HISTORY + 1); h <= tipHeight; h++) {
      if (h === tipHeight) blocks[h] = tipHash;
      else if (state.blocks[h] && (forkHeight === null ? !stored.length : h <= forkHeight)) blocks[h] = state.blocks[h];
      else if (!syncing) blocks[h] = await rpc("getblockhash", [h]);
    }
    state.blocks = blocks;

    // 2. Competing branches near the tip. The node also lists hundreds of old
    // one-block header branches, so only recent, long enough ones count.
    const tips = await rpc("getchaintips");
    const branches = tips.filter(
      (t) =>
        (t.status === "valid-fork" || t.status === "valid-headers") &&
        t.branchlen >= cfg.branchAlertLen &&
        t.height >= tipHeight - cfg.branchMaxAge
    );
    for (const t of branches) {
      if (state.reportedTips.includes(t.hash)) continue;
      state.reportedTips.push(t.hash);
      alerts.push({ channel: "chain", severity: "warning", title: "Competing branch", branch: t, tipHeight });
    }
    state.reportedTips = state.reportedTips.slice(-200);

    // 3. Stalled chain: once, a reminder every hour, and a message on recovery.
    const header = await rpc("getblockheader", [tipHash]);
    const age = Math.floor(now() / 1000) - header.time;
    if (age > cfg.stallSeconds) {
      if (!state.stall.active || now() - state.stall.lastAlert >= STALL_REMINDER_MS) {
        alerts.push({
          channel: "chain",
          severity: "warning",
          title: state.stall.active ? "Chain still stalled" : "Chain stalled",
          text: `No new block for ${duration(age)}. Last block ${tipHeight.toLocaleString("en-US")}.`,
          blockHash: tipHash,
        });
        state.stall.lastAlert = now();
      }
      state.stall.active = true;
    } else if (state.stall.active) {
      alerts.push({
        channel: "chain",
        severity: "ok",
        title: "Blocks resumed",
        text: `New block at height ${tipHeight.toLocaleString("en-US")}.`,
        blockHash: tipHash,
      });
      state.stall.active = false;
    }

    // 4. Peers
    if (net.connections < cfg.minPeers && !state.node.lowPeers) {
      state.node.lowPeers = true;
      alerts.push({ channel: "admin", severity: "warning", title: "Few peers", text: `Only ${net.connections} peer(s) connected (minimum ${cfg.minPeers}).` });
    } else if (net.connections >= cfg.minPeers && state.node.lowPeers) {
      state.node.lowPeers = false;
      alerts.push({ channel: "admin", severity: "ok", title: "Peers recovered", text: `${net.connections} peers connected.` });
    }

    save(state);
    lastHealth = {
      rpc: true,
      height: tipHeight,
      age,
      peers: net.connections,
      stalled: state.stall.active,
      reorgs24h: state.reorgs.length,
      deepestReorg24h: state.reorgs.reduce((m, r) => Math.max(m, r.depth), 0),
      branches: branches.length,
      updated: now(),
    };
    return { health: lastHealth, alerts };
  }

  return { check, getHealth: () => lastHealth };
}

module.exports = { createMonitor, configFromEnv, duration };
