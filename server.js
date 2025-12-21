/**
 * ENGINE – Market Data Backend
 *
 * - Fetches metals.dev data
 * - Caches calendar-based closes
 * - Computes deltas and signals
 * - Exposes data via Shopify App Proxy
 */

const express = require("express");
const crypto = require("crypto");
const cron = require("node-cron");

const app = express();

const { getPricing } = require("./pricing");

/* -----------------------------
   CONFIGURATION
-------------------------------- */

// Days used for median signal
const varE = 7;

// Spot refresh frequency (minutes)
const varF = 10;

// Troy ounces per token
const varH = 0.1;

/* -----------------------------
   ENVIRONMENT
-------------------------------- */

const API_KEY = process.env.PUBLISHER_API_KEY;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error("Missing PUBLISHER_API_KEY");
  process.exit(1);
}

/* -----------------------------
   CACHE (IN-MEMORY)
-------------------------------- */

const cache = {
  // Private reference closes (calendar-based)
  varC1: null,
  varC30: null,
  varC365: null,

  // Public market outputs
  varS: null,
  varSi: null,

  varCd: null,
  varCdp: null,

  varCm: null,
  varCmp: null,

  varCy: null,
  varCyp: null,

  // Median signal
  varSm: null,

  // Last update timestamp
  updatedAt: null
};

/* -----------------------------
   HELPERS
-------------------------------- */

/* Rounding */
function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

function round1(v) {
  return Number.isFinite(v) ? Number(v.toFixed(1)) : null;
}

/* Date formatting */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/* Date manipulation */
function dateMinus(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return fmtDate(d);
}

/* Median calculation for deduplicated signal */
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : Math.max(a[n / 2 - 1], a[n / 2]);
}

/* Remove consecutive duplicates */
function dedupeConsecutive(arr) {
  return arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
}

/* -----------------------------
   SHOPIFY APP PROXY VERIFICATION
-------------------------------- */

// Function to verify the proxy signature for Shopify requests
function verifyProxy(req) {
  const { signature, ...params } = req.query;
  if (!signature) return false;

  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_APP_SECRET)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(signature)
  );
}

/* -----------------------------
   DATA FETCHERS
-------------------------------- */

/**
 * Fetch single calendar close for a specific date
 * This retrieves the silver close price for a given date from the API
 */
async function fetchCloseForDate(date) {
  const url = new URL("https://api.metals.dev/v1/timeseries");
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);

  const res = await fetch(url);
  const data = await res.json();

  const day = Object.values(data?.rates || {})[0];
  const v = Number(day?.metals?.silver);
  return Number.isFinite(v) ? v : null;
}

/**
 * Fetch varE-day timeseries
 * - Populate calendar-based closes (private)
 * - Compute deduplicated median signal (public)
 */
async function fetchTimeseries() {
  const url = new URL("https://api.metals.dev/v1/timeseries");
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("start_date", dateMinus(varE * 2));
  url.searchParams.set("end_date", dateMinus(1)); 

  const res = await fetch(url);
  const data = await res.json();

  const rates = data?.rates || {};
  const closesByDate = {};

  for (const [date, obj] of Object.entries(rates)) {
    const v = Number(obj?.metals?.silver);
    if (Number.isFinite(v)) closesByDate[date] = v;
  }

  // Calendar-based reference closes (FETCHED INDEPENDENTLY)
  cache.varC1 = await fetchCloseForDate(dateMinus(1));  // Fetch data for 1 day ago
  cache.varC30 = await fetchCloseForDate(dateMinus(30));  // Fetch data for 30 days ago
  cache.varC365 = await fetchCloseForDate(dateMinus(365));  // Fetch data for 365 days ago

  // Deduplicated trading closes → median signal
  const ordered = Object.keys(closesByDate)
    .sort()
    .map((d) => closesByDate[d]);

  const trading = dedupeConsecutive(ordered);
  cache.varSm = round2(median(trading.slice(-varE)));
}

/**
 * Fetch live spot price and compute deltas
 * This gets the current silver spot price and computes changes relative to the cached reference closes
 */
async function fetchSpot() {
  const url = new URL("https://api.metals.dev/v1/metal/spot");
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("metal", "silver");
  url.searchParams.set("currency", "USD");

  const res = await fetch(url);
  const data = await res.json();

  const S = Number(data?.rate?.price);
  if (!Number.isFinite(S)) return;

  cache.varS = round2(S);
  cache.varSi = round2(S * varH);

  if (cache.varC1) {
    cache.varCd = round2(S - cache.varC1);
    cache.varCdp = round1((cache.varCd / cache.varC1) * 100);
  }

  if (cache.varC30) {
    cache.varCm = round2(S - cache.varC30);
    cache.varCmp = round1((cache.varCm / cache.varC30) * 100);
  }

  if (cache.varC365) {
    cache.varCy = round2(S - cache.varC365);
    cache.varCyp = round1((cache.varCy / cache.varC365) * 100);
  }

  cache.updatedAt = new Date().toISOString();
}

/* -----------------------------
   SCHEDULING
-------------------------------- */

// Run immediately on deploy to fetch initial market data
(async () => {
  await fetchTimeseries();
  await fetchSpot();
})();

// Run daily at 11:10 UTC to refresh timeseries data
cron.schedule("10 11 * * *", fetchTimeseries, { timezone: "UTC" });

// Refresh spot price every varF minutes
setInterval(fetchSpot, varF * 60 * 1000);

/* -----------------------------
   SHOPIFY APP PROXY ENDPOINT
-------------------------------- */

// Proxy endpoint to expose market data for frontend
app.get("/proxy/market", (req, res) => {
  // Disable all caching (browser + Shopify CDN)
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (!verifyProxy(req)) {
    return res.status(403).json({ error: "invalid proxy signature" });
  }

  // UI-safe market payload
  res.json({
    varS: cache.varS,
    varSi: cache.varSi,

    varCd: cache.varCd,
    varCdp: cache.varCdp,

    varCm: cache.varCm,
    varCmp: cache.varCmp,

    varCy: cache.varCy,
    varCyp: cache.varCyp,

    varSm: cache.varSm,
    updatedAt: cache.updatedAt
  });
});

// Proxy endpoint to expose pricing data based on quantity
app.get("/proxy/pricing", (req, res) => {
  // Disable caching
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Verify Shopify App Proxy
  if (!verifyProxy(req)) {
    return res.status(403).json({ error: "invalid proxy signature" });
  }

  // Parse + validate quantity
  const varQ = Number(req.query.varQ);
  if (!Number.isFinite(varQ) || varQ <= 0) {
    return res.status(400).json({ error: "invalid quantity" });
  }

  // Optional hard cap
  const MAX_Q = 500;
  if (varQ > MAX_Q) {
    return res.status(400).json({ error: "quantity too large" });
  }

  // Ensure required market data exists
  if (!Number.isFinite(cache.varSm)) {
    return res.status(503).json({ error: "pricing unavailable" });
  }

  // Compute pricing
  const pricing = getPricing(cache, varQ);
  if (!pricing) {
    return res.status(503).json({ error: "pricing unavailable" });
  }

  // Success
  res.json(pricing);
});

/* -----------------------------
   START SERVER
-------------------------------- */

// Start the backend server
app.listen(PORT, () => {
  console.log(`ENGINE backend running on port ${PORT}`);
});
