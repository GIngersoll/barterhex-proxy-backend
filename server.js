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

// Days used for median signal (look-back period)
const varE = 7;

// Spot refresh frequency (minutes)
const varF = 10;

// Troy ounces per token
const varH = 0.1;

/* -----------------------------
   ENVIRONMENT VARIABLES
-------------------------------- */

const API_KEY = process.env.PUBLISHER_API_KEY;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET;
const PORT = process.env.PORT || 3000;

// Ensure the API key is set, or terminate
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
  varCdInitialized: false,

  // Cache for second-to-last close (Thursday's close)
  varC2Prev: null
};

// Determine whether the market is open based on time (clock-based)
function isMarketOpenByClock(now = Date.now()) {
  return now >= cache.varMOpen && now <= cache.varMClose;
}

// Calculate market bounds: market opens Sunday 6 PM ET, closes Friday 5 PM ET
function getWeeklyMarketBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  const day = now.getUTCDay(); // 0=Sun … 6=Sat

  // Find Sunday of the current week
  const sunday = new Date(Date.UTC(year, month, date - day));

  // Sunday 6:00 PM ET → market open
  const varMOpen = toET(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate(), 18);

  // Friday 5:00 PM ET → market close
  const friday = new Date(sunday);
  friday.setUTCDate(friday.getUTCDate() + 5);

  const varMClose = toET(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate(), 17);

  return { varMOpen, varMClose };
}

// Convert to Eastern Time (ET)
const { varMOpen, varMClose } = getWeeklyMarketBounds();
cache.varMOpen = varMOpen;
cache.varMClose = varMClose;

cache.varMCon = isMarketOpenByClock() ? 1 : 0;  // Market status: 1=open, 0=closed

let lastVarS = null; // Previous spot price
let sameCount = 0;   // Counter for unchanged prices
let confirmCount = 0; // Confirmation counter to detect frozen market

let pollIntervalMs = varF * 60 * 1000; // Default polling interval (10 minutes)
let pollTimer = null;

const EPS = 1e-6; // Float safety for price comparison

/* -----------------------------
   HELPERS
-------------------------------- */

// Calculate Eastern Time offset for daylight saving adjustments
function getEasternOffset(date = new Date()) {
  const jan = new Date(date.getFullYear(), 0, 1);
  const jul = new Date(date.getFullYear(), 6, 1);
  return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

// Convert UTC time to Eastern Time (ET)
function toET(year, month, day, hour, minute = 0) {
  const d = new Date(Date.UTC(year, month, day, hour, minute));
  d.setUTCMinutes(d.getUTCMinutes() + getEasternOffset(d));
  return d.getTime();
}

// Rounding helpers for floating point numbers
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

// Calculate median value from an array
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : Math.max(a[n / 2 - 1], a[n / 2]);
}

// Deduplicate consecutive identical values in an array
function dedupeConsecutive(arr) {
  return arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
}

/* -----------------------------
   SHOPIFY APP PROXY VERIFICATION
-------------------------------- */

// Verifies Shopify App Proxy request using signature
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

// Fetch close price with fallback for previous days
async function fetchCloseWithFallback(daysAgo, maxBack = 7) {
  for (let i = 0; i <= maxBack; i++) {
    const v = await fetchCloseForDate(dateMinus(daysAgo + i));
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Fetch varE-day timeseries (fetches historical market data)
 */
async function fetchTimeseries() {
  const url = new URL("https://api.metals.dev/v1/timeseries");
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("start_date", dateMinus(varE * 2));
  url.searchParams.set("end_date", dateMinus(1));

  const res = await fetch(url);
  const data = await res.json();

  const rates = data?.rates || {};

  // Filter relevant market closes
  const HistoryLessMarketClosed = [];

  for (const [date, obj] of Object.entries(rates)) {
    const v = Number(obj?.metals?.silver);
    if (Number.isFinite(v)) {
      HistoryLessMarketClosed.push({ date, close: v });
    }
  }

  // Sort history by date (ascending)
  HistoryLessMarketClosed.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Track second-to-last close (e.g., Thursday's close)
  if (HistoryLessMarketClosed.length >= 2) {
    cache.varC2Prev = HistoryLessMarketClosed[HistoryLessMarketClosed.length - 2].close;
  }

  // Set the most recent and previous close
  cache.varC1 = await fetchCloseWithFallback(1);  // Most recent trading close
  cache.varC1Prev = HistoryLessMarketClosed[HistoryLessMarketClosed.length - 1]?.close || null; // Last close
  cache.varC30 = await fetchCloseForDate(dateMinus(30));
  cache.varC365 = await fetchCloseForDate(dateMinus(365));

  // Median signal (differentiated market signals)
  const ordered = HistoryLessMarketClosed.map(item => item.close);
  const trading = dedupeConsecutive(ordered);
  cache.varSm = round2(median(trading.slice(-varE)));
}

/**
 * Reset the polling timer (restarts polling with new interval)
 */
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

  ({ varMOpen: cache.varMOpen, varMClose: cache.varMClose } = getWeeklyMarketBounds());
  const clockOpen = isMarketOpenByClock();

  // MARKET CLOSED LOGIC
  if (!clockOpen) {
    cache.varMCon = 0; // Market closed

    sameCount = 0;
    confirmCount = 0;
    lastVarS = null;
  } else if (cache.varMCon === 1) {
    // Market OPEN – Heuristic for potential freezes (price remains same)
    if (lastVarS !== null && Math.abs(newVarS - lastVarS) < EPS) {
      sameCount++;

      // After 2 identical values → slow polling (2 minutes)
      if (sameCount === 2) {
        pollIntervalMs = 2 * 60 * 1000; // Adjust polling to 2 minutes
        resetPollTimer();
      }

      // After 5 unchanged prices → assume market is frozen, reset to 10 minutes polling
      if (sameCount > 2) {
        confirmCount++;
        if (confirmCount >= 5) {
          cache.varMCon = 0; // Mark market as closed
          pollIntervalMs = varF * 60 * 1000; // Reset to default polling interval (10 minutes)
          resetPollTimer();
        }
      }
    } else {
      // Price changed → Market open, reset counters
      cache.varMCon = 1; // Market open
      sameCount = 0;
      confirmCount = 0;

      // Reset polling interval to default (10 minutes)
      pollIntervalMs = varF * 60 * 1000;
      resetPollTimer(); // Restart polling with the new interval
    }
  }

  lastVarS = newVarS;
  cache.varS = newVarS;
  cache.varSi = round2(newVarS * varH);

  // --- 1D DELTA LOGIC ---
  if (cache.varC1 && cache.varC1Prev) {
    if (!cache.varCdInitialized) {
      const ref = cache.varMCon === 1
        ? cache.varC1
        : cache.varC1Prev;  // Use last valid close (varC1Prev)

      cache.varCdSession = round2(newVarS - ref);  // Compare varS with varC1Prev during closure
      cache.varCdpSession = round1((cache.varCdSession / ref) * 100);
      cache.varCdInitialized = true;
    }

    // Live recompute only when market is open
    if (cache.varMCon === 1) {
      cache.varCdSession = round2(newVarS - cache.varC1);
      cache.varCdpSession = round1((cache.varCdSession / cache.varC1) * 100);
    } else {
      // If market is closed, compare varS to the last valid close (varC1Prev or varC2Prev)
      if (!clockOpen) {
        const refClose = cache.varC1Prev;  // Use the last close (varC1Prev)
        cache.varCdSession = round2(newVarS - refClose);      // Calculate delta using varS and varC1Prev
        cache.varCdpSession = round1((cache.varCdSession / refClose) * 100);  // Calculate percentage delta
      }
    }

    cache.varCd = cache.varCdSession;
    cache.varCdp = cache.varCdpSession;
  }

  // --- 30-Day and 365-Day Deltas ---
  if (cache.varC30) {
    cache.varCm = round2(newVarS - cache.varC30);  // 30-day delta
    cache.varCmp = round1((cache.varCm / cache.varC30) * 100);  // 30-day percentage delta
  }

  if (cache.varC365) {
    cache.varCy = round2(newVarS - cache.varC365);  // 365-day delta
    cache.varCyp = round1((cache.varCy / cache.varC365) * 100);  // 365-day percentage delta
  }

  cache.updatedAt = new Date().toISOString(); // Timestamp of the latest update
}


/* -----------------------------
   SCHEDULING
-------------------------------- */

// Run immediately on deploy to fetch initial data
(async () => {
  await fetchTimeseries();
  await fetchSpot();
})();

// Daily at 11:10 UTC, fetch timeseries data
cron.schedule("10 11 * * *", fetchTimeseries, { timezone: "UTC" });

// Spot refresh every varF minutes (default 10 minutes)
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

  // Verify Shopify App Proxy signature
  if (!verifyProxy(req)) {
    return res.status(403).json({ error: "invalid proxy signature" });
  }

  // UI-safe market data payload
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

// Shopify pricing proxy endpoint
app.get("/proxy/pricing", (req, res) => {
  // Disable caching for pricing response
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Verify Shopify App Proxy signature
  if (!verifyProxy(req)) {
    return res.status(403).json({ error: "invalid proxy signature" });
  }

  // Parse and validate quantity
  const varQ = Number(req.query.varQ);
  if (!Number.isFinite(varQ) || varQ <= 0) {
    return res.status(400).json({ error: "invalid quantity" });
  }

  // Optional quantity hard cap
  const MAX_Q = 500;
  if (varQ > MAX_Q) {
    return res.status(400).json({ error: "quantity too large" });
  }

  // Ensure required market data is available
  if (!Number.isFinite(cache.varSm)) {
    return res.status(503).json({ error: "pricing unavailable" });
  }

  // Compute pricing for the requested quantity
  const pricing = getPricing(cache, varQ);
  if (!pricing) {
    return res.status(503).json({ error: "pricing unavailable" });
  }

  // Respond with pricing data
  res.json(pricing);
});

// Start server
app.listen(PORT, () => {
  console.log(`ENGINE backend running on port ${PORT}`);
});

