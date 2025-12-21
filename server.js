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

// Previous trading days used for median signal. Max 20
const varE = 7;

// Spot refresh frequency (minutes)
const varF = 10;

// Troy ounces per token
const varH = 0.1;

// Market opening and closing times (user-defined, in human-readable format)
const varMOpen = new Date();
varMOpen.setHours(18, 0, 0, 0); // Market opens at 6:00 PM on Sunday

const varMClose = new Date();
varMClose.setHours(17, 0, 0, 0); // Market closes at 5:00 PM on Friday

// Break start and end times (Monday to Thursday)
const varMOnBreak = [
  new Date().setHours(17, 0, 0, 0), // Monday break start at 5:00 PM
  new Date().setHours(17, 0, 0, 0), // Tuesday break start at 5:00 PM
  new Date().setHours(17, 0, 0, 0), // Wednesday break start at 5:00 PM
  new Date().setHours(17, 0, 0, 0), // Thursday break start at 5:00 PM
];

const varMOffBreak = [
  new Date().setHours(18, 0, 0, 0), // Monday break end at 6:00 PM
  new Date().setHours(18, 0, 0, 0), // Tuesday break end at 6:00 PM
  new Date().setHours(18, 0, 0, 0), // Wednesday break end at 6:00 PM
  new Date().setHours(18, 0, 0, 0), // Thursday break end at 6:00 PM
];

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

  // Market status
  varMStatus: null,

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
  const date = new Date();
  // Set the date to Eastern Time (ET)
  const easternTime = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  easternTime.setDate(easternTime.getDate() - days);
  return easternTime.toISOString().slice(0, 10);  // Returns date in "YYYY-MM-DD" format
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

function calculateDeltas() {
  // Ensure required values are available
  if (cache.varS && cache.varC1 && cache.varC30 && cache.varC365) {
    const S = cache.varS;
    const C1 = cache.varC1;
    const C30 = cache.varC30;
    const C365 = cache.varC365;

    // Calculate deltas
    cache.varCd = round2(S - C1);
    cache.varCdp = round1((cache.varCd / C1) * 100);

    cache.varCm = round2(S - C30);
    cache.varCmp = round1((cache.varCm / C30) * 100);

    cache.varCy = round2(S - C365);
    cache.varCyp = round1((cache.varCy / C365) * 100);

    // Log results for debugging
    console.log("Deltas calculated:");
    console.log("varCd:", cache.varCd, "varCdp:", cache.varCdp);
    console.log("varCm:", cache.varCm, "varCmp:", cache.varCmp);
    console.log("varCy:", cache.varCy, "varCyp:", cache.varCyp);
  } else {
    console.log("Missing values for delta calculation. Waiting for missing data...");
  }
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

  // Log the raw response data for debugging
  console.log("API Response:", data);

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
  url.searchParams.set("start_date", dateMinus(varE + 10));
  url.searchParams.set("end_date", dateMinus(1)); 

  const res = await fetch(url);
  const data = await res.json();

  const rates = data?.rates || {};
  const closesByDate = {};

  for (const [date, obj] of Object.entries(rates)) {
    const v = Number(obj?.metals?.silver);
    if (Number.isFinite(v)) closesByDate[date] = v;
  }

  // Pre-deduplication: This array will include all the fetched close values.
  const ordered = Object.keys(closesByDate)
    .sort()
    .map((d) => closesByDate[d]);

  // Deduplication
  const trading = dedupeConsecutive(ordered);

  // Now, instead of just using the previous day's close for varC1, we find the most recent close that doesn't match varS
  let foundValidC1 = false;
  for (let i = trading.length - 1; i >= 0; i--) {
    if (trading[i] !== cache.varS) {
      cache.varC1 = trading[i]; // Use this close as varC1
      foundValidC1 = true;
      break;
    }
  }

  // If no valid C1 is found (which should be rare if varS isn't the same as the close), fall back to previous day's close
  if (!foundValidC1) {
    cache.varC1 = trading[trading.length - 1]; // Fallback to the last close if no different value is found
  }

  // Longer horizons (no special handling needed)
  cache.varC30 = await fetchCloseForDate(dateMinus(30));  // Fetch data for 30 days ago
  cache.varC365 = await fetchCloseForDate(dateMinus(365));  // Fetch data for 365 days ago

  console.log("Fetched varC1:", cache.varC1);
  console.log("Fetched varC30:", cache.varC30);
  console.log("Fetched varC365:", cache.varC365);

   // Trigger delta calculation after fetching all historic close values
  calculateDeltas();

  // Deduplicated trading closes → median signal
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

  console.log("Current spot price (S):", S);
   
  if (!Number.isFinite(S)) return;

  // Set the global market status variable based on Eastern Time
  const varMStatus = getMarketStatus();

  // You can log the market status for debugging or display purposes
  console.log("Updated Market Status:", varMStatus);
   
  // Call delta calculation after fetching spot price
  calculateDeltas();
   
  cache.varS = round2(S);
  cache.varSi = round2(S * varH);
  cache.varMStatus = varMStatus;
   
  cache.updatedAt = new Date().toISOString();
}

const varMstat = getMarketStatus();

function getMarketStatus() {
  // Get current date and time in Eastern Time (ET)
  const now = new Date();
  const EastCoastTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  // Extract Eastern Time (ET) values
  const currentHour = EastCoastTime.getHours();
  const currentMinute = EastCoastTime.getMinutes();
  const dayOfWeek = EastCoastTime.getDay();  // 0 = Sunday, 6 = Saturday
  
  // Log current time in Eastern Time
  console.log('Current time in Eastern Time:', EastCoastTime);
  console.log('Current hour in Eastern Time:', currentHour);
  console.log('Current day of the week in Eastern Time:', dayOfWeek);

  // Check if it's Monday to Thursday and between the break times
  if (dayOfWeek >= 1 && dayOfWeek <= 4) {
    const breakStart = varMOnBreak[dayOfWeek - 1];  // Break start for current day
    const breakEnd = varMOffBreak[dayOfWeek - 1];   // Break end for current day

    if (EastCoastTime >= breakStart && EastCoastTime < breakEnd) {
      return 2; // Market is on break (lunch)
    }
    return 1; // Market is open
  }

  // Check if it's Friday and after market close time
  if (dayOfWeek === 5) {
    if (EastCoastTime >= varMClose) {
      return 0; // Market is closed after market close time on Friday
    }
    return 1; // Market is open on Friday before close time
  }

  // Check if it's Sunday and after market open time
  if (dayOfWeek === 0) {
    if (EastCoastTime >= varMOpen) {
      return 1; // Market is open after market open time on Sunday
    }
    return 0; // Market is closed on Sunday before open time
  }

  // Check for Saturday (market is closed)
  return 0; // Market is closed on Saturday
}

/* -----------------------------
   SCHEDULING
-------------------------------- */

// Run immediately on deploy to fetch initial market data
(async () => {
  await fetchSpot();
  await fetchTimeseries();
})();

// Run daily at 6:10 Eastern Time to refresh timeseries data
cron.schedule("10 6 * * *", fetchTimeseries, { timezone: "America/New_York" });

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
    varMStatus: cache.varMStatus,
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
  const MAX_Q = 100;
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
















