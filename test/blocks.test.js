const test = require("node:test");
const assert = require("node:assert");
const { createBlockHandler } = require("../blocks");

const noSleep = () => Promise.resolve();
const quiet = () => {};

test("waits until the explorer reaches the node height, then refreshes once", async () => {
  let explorer = 100;
  let polls = 0;
  let refreshes = 0;
  const h = createBlockHandler({
    getNodeHeight: async () => 101,
    getExplorerHeight: async () => {
      polls++;
      if (polls === 3) explorer = 101;
      return explorer;
    },
    refresh: async () => { refreshes++; assert.strictEqual(explorer, 101); },
    sleep: noSleep, log: quiet,
  });
  await h.run();
  assert.strictEqual(refreshes, 1);
  assert.strictEqual(polls, 3);
});

test("refreshes anyway when the explorer never catches up", async () => {
  let refreshes = 0;
  const h = createBlockHandler({
    getNodeHeight: async () => 200,
    getExplorerHeight: async () => 1,
    refresh: async () => { refreshes++; },
    maxWaitMs: 9000, pollMs: 3000, sleep: noSleep, log: quiet,
  });
  await h.run();
  assert.strictEqual(refreshes, 1);
});

test("refreshes when the node height call fails", async () => {
  let refreshes = 0;
  const h = createBlockHandler({
    getNodeHeight: async () => { throw new Error("rpc down"); },
    getExplorerHeight: async () => 0,
    refresh: async () => { refreshes++; },
    sleep: noSleep, log: quiet,
  });
  await h.run();
  assert.strictEqual(refreshes, 1);
});

test("a burst of blocks becomes a single refresh", async () => {
  let refreshes = 0;
  const h = createBlockHandler({
    getNodeHeight: async () => 5,
    getExplorerHeight: async () => 5,
    refresh: async () => { refreshes++; },
    debounceMs: 20, sleep: noSleep, log: quiet,
  });
  h.onBlock(); h.onBlock(); h.onBlock();
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(refreshes, 1);
});

test("a block arriving during a refresh triggers one more run, never two at once", async () => {
  let refreshes = 0;
  let active = 0;
  let maxActive = 0;
  let h;
  h = createBlockHandler({
    getNodeHeight: async () => 5,
    getExplorerHeight: async () => 5,
    refresh: async () => {
      active++; maxActive = Math.max(maxActive, active);
      refreshes++;
      if (refreshes === 1) { h.run(); } // new block while the first refresh is running
      await new Promise((r) => setTimeout(r, 10));
      active--;
    },
    sleep: noSleep, log: quiet,
  });
  await h.run();
  assert.strictEqual(refreshes, 2);
  assert.strictEqual(maxActive, 1);
});

test("a failing refresh does not throw or block later runs", async () => {
  let calls = 0;
  const h = createBlockHandler({
    getNodeHeight: async () => 5,
    getExplorerHeight: async () => 5,
    refresh: async () => { calls++; if (calls === 1) throw new Error("discord down"); },
    sleep: noSleep, log: quiet,
  });
  await h.run();
  await h.run();
  assert.strictEqual(calls, 2);
});
