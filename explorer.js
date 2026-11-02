// explorer.js
const axios = require("axios");
require("dotenv").config();

const API = process.env.EXPLORER_API;

const RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// GET with retries on network errors (DNS, reset, timeout) and 5xx responses
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await axios.get(`${API}${path}`, { timeout: 15000 });
      return data;
    } catch (err) {
      const status = err.response?.status;
      const retryable = !status || status >= 500;
      if (!retryable || attempt >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

async function getBlockCount() {
  return Number(await get("/api/getblockcount"));
}

async function getDifficulty() {
  return Number(await get("/api/getdifficulty"));
}

async function getNetworkHash() {
  return Number(await get("/api/getnetworkhashps"));
}

async function getMoneySupply() {
  return get("/api/supply"); // return the full JSON object
}

// price placeholder – returns "N/A" until markets exist
async function getPrice() {
  return get("/api/price");
}

module.exports = {
  getBlockCount,
  getDifficulty,
  getNetworkHash,
  getMoneySupply,
  getPrice,
};
