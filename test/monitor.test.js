const test = require("node:test");
const assert = require("node:assert");
const { createMonitor, configFromEnv } = require("../monitor");

// A fake node: chain[h] is the block hash at height h on the active chain
function fakeNode(len) {
  const node = {
    chain: Array.from({ length: len }, (_, h) => `h${h}a`),
    time: 1_000_000,
    peers: 10,
    tips: [],
    down: false,
    ibd: false,
  };
  node.rpc = async (method, params = []) => {
    if (node.down) throw new Error("connect ECONNREFUSED");
    const tip = node.chain.length - 1;
    if (method === "getblockchaininfo") return { blocks: tip, bestblockhash: node.chain[tip], initialblockdownload: node.ibd };
    if (method === "getnetworkinfo") return { connections: node.peers };
    if (method === "getblockhash") return node.chain[params[0]];
    if (method === "getblockheader") return { time: node.time };
    if (method === "getchaintips") return node.tips;
    throw new Error(`unexpected ${method}`);
  };
  return node;
}

function harness(node, cfg = {}) {
  let state = {};
  let clock = node.time * 1000 + 60_000;
  const m = createMonitor({
    rpc: node.rpc,
    cfg: { ...configFromEnv({}), ...cfg },
    load: () => JSON.parse(JSON.stringify(state)),
    save: (s) => (state = JSON.parse(JSON.stringify(s))),
    now: () => clock,
    log: () => {},
  });
  return { m, advance: (ms) => (clock += ms), getState: () => state };
}

test("quiet chain: no alerts, history filled", async () => {
  const node = fakeNode(500);
  const { m, getState } = harness(node);
  const { alerts, health } = await m.check();
  assert.deepStrictEqual(alerts, []);
  assert.strictEqual(health.height, 499);
  assert.strictEqual(Object.keys(getState().blocks).length, 100);
});

test("new blocks extend the history without a reorg", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.chain.push("h500a", "h501a");
  const { alerts, health } = await m.check();
  assert.deepStrictEqual(alerts, []);
  assert.strictEqual(health.reorgs24h, 0);
});

test("1-block reorg is counted but not posted", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.chain[499] = "h499b";
  const { alerts, health } = await m.check();
  assert.deepStrictEqual(alerts, []);
  assert.strictEqual(health.reorgs24h, 1);
  assert.strictEqual(health.deepestReorg24h, 1);
});

test("3-block reorg: depth, fork height, old and new tip", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.chain = node.chain.slice(0, 497).concat(["h497b", "h498b", "h499b", "h500b"]);
  const { alerts } = await m.check();
  assert.strictEqual(alerts.length, 1);
  const r = alerts[0].reorg;
  assert.strictEqual(alerts[0].channel, "chain");
  assert.strictEqual(r.depth, 3);
  assert.strictEqual(r.forkHeight, 496);
  assert.deepStrictEqual(r.oldTip, { height: 499, hash: "h499a" });
  assert.deepStrictEqual(r.newTip, { height: 500, hash: "h500b" });
  // history follows the new chain, so the same reorg is not reported twice
  assert.deepStrictEqual((await m.check()).alerts, []);
});

test("reorg to a shorter chain counts the replaced blocks", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.chain = node.chain.slice(0, 496).concat(["h496b"]);
  const { alerts } = await m.check();
  assert.strictEqual(alerts[0].reorg.depth, 4);
  assert.strictEqual(alerts[0].reorg.forkHeight, 495);
});

test("reorg deeper than the history has forkHeight null", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.chain = Array.from({ length: 501 }, (_, h) => `h${h}x`);
  const { alerts } = await m.check();
  assert.strictEqual(alerts[0].reorg.forkHeight, null);
  assert.strictEqual(alerts[0].reorg.depth, 100);
});

test("competing branch: only recent and long enough, once", async () => {
  const node = fakeNode(500);
  node.tips = [
    { height: 499, hash: "tip", branchlen: 0, status: "active" },
    { height: 300, hash: "old", branchlen: 1, status: "valid-headers" },
    { height: 490, hash: "short", branchlen: 1, status: "valid-fork" },
    { height: 495, hash: "fork", branchlen: 4, status: "valid-fork" },
    { height: 495, hash: "hdr", branchlen: 3, status: "headers-only" },
  ];
  const { m } = harness(node);
  const first = await m.check();
  assert.strictEqual(first.alerts.length, 1);
  assert.strictEqual(first.alerts[0].branch.hash, "fork");
  assert.strictEqual(first.health.branches, 1);
  assert.deepStrictEqual((await m.check()).alerts, []);
});

test("stall: one alert, hourly reminder, recovery", async () => {
  const node = fakeNode(500);
  const { m, advance } = harness(node, { stallSeconds: 3 * 3600 });
  assert.deepStrictEqual((await m.check()).alerts, []);

  advance(3.5 * 3600 * 1000);
  let r = await m.check();
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].title, "Chain stalled");
  assert.strictEqual(r.health.stalled, true);

  advance(2 * 60 * 1000);
  assert.deepStrictEqual((await m.check()).alerts, []);

  advance(61 * 60 * 1000);
  r = await m.check();
  assert.strictEqual(r.alerts[0].title, "Chain still stalled");

  node.chain.push("h500a");
  node.time += 4 * 3600;
  r = await m.check();
  assert.strictEqual(r.alerts[0].title, "Blocks resumed");
  assert.strictEqual(r.alerts[0].severity, "ok");
  assert.deepStrictEqual((await m.check()).alerts, []);
});

test("node health: down after 2 failures, recovery, few peers", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.down = true;
  assert.deepStrictEqual((await m.check()).alerts, []); // first failure: wait
  let r = await m.check();
  assert.strictEqual(r.alerts[0].channel, "admin");
  assert.strictEqual(r.alerts[0].title, "Node unreachable");
  assert.deepStrictEqual((await m.check()).alerts, []); // not repeated
  node.down = false;
  node.peers = 2;
  r = await m.check();
  assert.deepStrictEqual(r.alerts.map((a) => a.title), ["Node reachable again", "Few peers"]);
  node.peers = 8;
  r = await m.check();
  assert.deepStrictEqual(r.alerts.map((a) => a.title), ["Peers recovered"]);
});

test("initial block download: no reorg alerts", async () => {
  const node = fakeNode(500);
  const { m } = harness(node);
  await m.check();
  node.ibd = true;
  node.chain = Array.from({ length: 300 }, (_, h) => `h${h}z`);
  assert.deepStrictEqual((await m.check()).alerts, []);
});
