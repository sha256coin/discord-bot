// rpc.js
const axios = require("axios");
require("dotenv").config();

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:25332";

// JSON-RPC call to the local node; an RPC error comes back as a thrown Error
async function call(method, params = []) {
  try {
    const { data } = await axios.post(
      RPC_URL,
      { jsonrpc: "1.0", id: "s256-bot", method, params },
      {
        auth: { username: process.env.RPC_USER, password: process.env.RPC_PASS },
        timeout: 10000,
      }
    );
    return data.result;
  } catch (err) {
    const rpcError = err.response?.data?.error;
    if (rpcError) throw new Error(`${method}: ${rpcError.message}`);
    throw err;
  }
}

module.exports = { call };
