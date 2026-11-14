// blocks.js
// Reacts to new blocks announced by the node over ZMQ (pubhashblock).
// createBlockHandler() is the logic (debounce, wait for the explorer to catch
// up, never run two refreshes at once); startZmq() is the socket. The 5-minute
// cron stays as the fallback if ZMQ is down.

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function createBlockHandler({
  getNodeHeight, // () => Promise<number>, the node's tip height
  getExplorerHeight, // () => Promise<number>, what the explorer API reports
  refresh, // () => Promise<void>, redraws the stats message
  debounceMs = 3000,
  pollMs = 3000,
  maxWaitMs = 90000,
  sleep = sleepMs,
  log = console.log,
}) {
  let timer = null;
  let running = false;
  let again = false;

  // The explorer syncs every 30 s, so refreshing right away would show the old
  // height. Wait until it reports the node's height, or give up after maxWaitMs
  // and refresh anyway.
  async function waitForExplorer(target) {
    for (let waited = 0; waited <= maxWaitMs; waited += pollMs) {
      try {
        if ((await getExplorerHeight()) >= target) return true;
      } catch (_) {
        /* explorer briefly unreachable: keep waiting */
      }
      await sleep(pollMs);
    }
    return false;
  }

  async function run() {
    if (running) {
      again = true; // another block arrived mid-refresh: run once more afterwards
      return;
    }
    running = true;
    try {
      do {
        again = false;
        let target = null;
        try {
          target = await getNodeHeight();
        } catch (err) {
          log(`Block refresh: node height unavailable (${err.message})`);
        }
        if (target != null && !(await waitForExplorer(target))) {
          log(`Block refresh: explorer still below ${target} after ${maxWaitMs / 1000}s, refreshing anyway`);
        }
        await refresh();
      } while (again);
    } catch (err) {
      log(`Block refresh failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  // Called for every announced block; a burst (e.g. a reorg) becomes one refresh
  function onBlock() {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  }

  return { onBlock, run, stop: () => clearTimeout(timer) };
}

// Subscribes to hashblock. zeromq reconnects by itself if the node restarts.
function startZmq(url, onBlock, log = console.log) {
  const zmq = require("zeromq");
  const sock = new zmq.Subscriber();
  sock.connect(url);
  sock.subscribe("hashblock");
  log(`ZMQ: listening for new blocks on ${url}`);
  (async () => {
    try {
      for await (const _msg of sock) onBlock();
    } catch (err) {
      log(`ZMQ subscriber stopped: ${err.message}. The 5-minute refresh keeps running.`);
    }
  })();
  return sock;
}

module.exports = { createBlockHandler, startZmq };
