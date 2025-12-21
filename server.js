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
  varC1Prev: null, // previous trading-day close
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
  updatedAt: null,
   
  varCdSession: null,
  varCdpSession: null,
};

function isMarketOpenByClock(now = Date.now()) {
  return now >= cache.varMOpen && now <= cache.varMClose;
}

function getWeeklyMarketBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  const day = now.getUTCDay(); // 0=Sun … 6=Sat

  // Find Sunday of current week
  const sunday = new Date(Date.UTC(year, month, date - day));

  // Sunday 6:00 PM ET → market open
  const varMOpen = toET(
    sunday.getUTCFullYear(),
    sunday.getUTCMonth(),
    sunday.getUTCDate(),
    18
  );

  // Friday 5:00 PM ET → market close
  const friday = new Date(sunday);
  friday.setUTCDate(friday.getUTCDate() + 5);

  const varMClose = toET(
    friday.getUTCFullYear(),
    friday.getUTCMonth(),
    friday.getUTCDate(),
    17
  );

  return { varMOpen, varMClose };
}

const { varMOpen, varMClose } = getWeeklyMarketBounds();
cache.varMOpen = varMOpen;
cache.varMClose = varMClose;

cache.varMCon = isMarketOpenByClock() ? 1 : 0;

let lastVarS = null;
let sameCount = 0;
let confirmCount = 0;

let pollIntervalMs = varF * 60 * 1000; // current polling interval
let pollTimer = null;

const EPS = 1e-6; // float safety

/* -----------------------------
   HELPERS
-------------------------------- */

function getEasternOffset(date = new Date()) {
  // Approximate ET offset handling (DST-safe enough for weekly bounds)
  const jan = new Date(date.getFullYear(), 0, 1);
  const jul = new Date(date.getFullYear(), 6, 1);
  return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

function toET(year, month, day, hour, minute = 0) {
  const d = new Date(Date.UTC(year, month, day, hour, minute));
  d.setUTCMinutes(d.getUTCMinutes() + getEasternOffset(d));
  return d.getTime();
}

/* Rounding */
function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

function round1(v) {
  return Number.isFinite(v) ? Number(v.toFixed(1)) : null;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function dateMinus(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return fmtDate(d);
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : Math.max(a[n / 2 - 1], a[n / 2]);
}

function dedupeConsecutive(arr) {
  return arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
}

/* -----------------------------
   SHOPIFY APP PROXY VERIFICATION
-------------------------------- */

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

async function fetchCloseWithFallback(daysAgo, maxBack = 7) {
  for (let i = 0; i <= maxBack; i++) {
    const v = await fetchCloseForDate(dateMinus(daysAgo + i));
    if (Number.isFinite(v)) return v;
  }
  return null;
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

// Most recent trading close
cache.varC1 = await fetchCloseWithFallback(1);

// Prior trading close (used when market is closed)
cache.varC1Prev = await fetchCloseWithFallback(2);

// Longer horizons
cache.varC30  = await fetchCloseForDate(dateMinus(30));
cache.varC365 = await fetchCloseForDate(dateMinus(365));

  // Deduplicated trading closes → median signal
  const ordered = Object.keys(closesByDate)
    .sort()
    .map((d) => closesByDate[d]);

  const trading = dedupeConsecutive(ordered);
  cache.varSm = round2(median(trading.slice(-varE)));
}

function resetPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchSpot, pollIntervalMs);
}

/**
 * Fetch live spot price and compute deltas
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

  const newVarS = round2(S);

   ({ varMOpen: cache.varMOpen, varMClose: cache.varMClose } =
     getWeeklyMarketBounds());
   
   const clockOpen = isMarketOpenByClock();
   
   // CLOCK IS AUTHORITATIVE
   if (!clockOpen) {
     cache.varMCon = 0;
   
     sameCount = 0;
     confirmCount = 0;
     lastVarS = null;
   }
   else if (cache.varMCon === 1) {
   // Clock says OPEN → heuristic may override
   
     if (lastVarS !== null && Math.abs(newVarS - lastVarS) < EPS) {
       sameCount++;
   
       // 2 identical values → slow polling
      if (sameCount === 2) {
         pollIntervalMs = 2 * 60 * 1000;
      resetPollTimer();
       }

    // count confirmations AFTER the first 2
    if (sameCount > 2) {
      confirmCount++;

      // 2 + 5 identical → force closed
      if (confirmCount >= 5) {
        cache.varMCon = 0;
        pollIntervalMs = varF * 60 * 1000;
        resetPollTimer();
      }
    }

  } else {
    // PRICE CHANGED
        
   cache.varMCon = 1;
        
    sameCount = 0;
    confirmCount = 0;

    if (pollIntervalMs !== varF * 60 * 1000) {
      pollIntervalMs = varF * 60 * 1000;
      resetPollTimer();
    }
  }
}

  lastVarS = newVarS;

  cache.varS = newVarS;
  cache.varSi = round2(newVarS * varH);

  if (cache.varC1) {
  if (cache.varMCon === 1) {
    // Market open → recompute session delta
    const refClose = cache.varC1;

    cache.varCdSession = round2(newVarS - refClose);
    cache.varCdpSession = round1((cache.varCdSession / refClose) * 100);
  }

  // Always expose last valid session delta
  cache.varCd = cache.varCdSession;
  cache.varCdp = cache.varCdpSession;
}



  if (cache.varC30) {
    cache.varCm = round2(newVarS - cache.varC30);
    cache.varCmp = round1((cache.varCm / cache.varC30) * 100);
  }

  if (cache.varC365) {
    cache.varCy = round2(newVarS - cache.varC365);
    cache.varCyp = round1((cache.varCy / cache.varC365) * 100);
  }

  cache.updatedAt = new Date().toISOString();
}


/* -----------------------------
   SCHEDULING
-------------------------------- */

// Run immediately on deploy
(async () => {
  await fetchTimeseries();
  await fetchSpot();
})();

// Daily at 11:10 UTC
cron.schedule("10 11 * * *", fetchTimeseries, { timezone: "UTC" });

// Spot refresh every varF minutes
pollIntervalMs = varF * 60 * 1000;
pollTimer = setInterval(fetchSpot, pollIntervalMs);

/* -----------------------------
   SHOPIFY APP PROXY ENDPOINT
-------------------------------- */

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
   
     varMCon: cache.varMCon,
   
     updatedAt: cache.updatedAt
   });
});

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

app.listen(PORT, () => {
  console.log(`ENGINE backend running on port ${PORT}`);
});






