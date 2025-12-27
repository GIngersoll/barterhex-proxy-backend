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

const { updateMarketStatus } = require("./marketStatus");
const { getPricing } = require("./pricing");

const app = express();

app.use(express.json());

console.log("SHOPIFY_API_KEY:", process.env.SHOPIFY_API_KEY);

/* -----------------------------
   CONFIGURATION
-------------------------------- */

// Previous trading days used for median signal. Max 20
const varE = 7;

// Spot refresh frequency (minutes)
const varF = 10;

// Troy ounces per token
const varH = 0.1;

// Draft order expiration (minutes)
const DRAFT_EXPIRY_MINUTES = 10;

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
  updatedAt: null,

  alertmode: 0,

  ready: false
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

/* Takes newly polled varC* variables and varS to calculate market deltas */
function calculateDeltas() {
  if (!Number.isFinite(cache.varS)) {
    console.log("Delta skipped: missing varS");
    return; // nothing can compute without spot
  }

  if (Number.isFinite(cache.varC1)) {
    cache.varCd  = round2(cache.varS - cache.varC1);
    cache.varCdp = round1((cache.varCd / cache.varC1) * 100);
  } else {
    console.log("Delta (1D) skipped: missing varC1");
  }

  if (Number.isFinite(cache.varC30)) {
    cache.varCm  = round2(cache.varS - cache.varC30);
    cache.varCmp = round1((cache.varCm / cache.varC30) * 100);
  } else {
    console.log("Delta (30D) skipped: missing varC30");
  }

  if (Number.isFinite(cache.varC365)) {
    cache.varCy  = round2(cache.varS - cache.varC365);
    cache.varCyp = round1((cache.varCy / cache.varC365) * 100);
  } else {
    console.log("Delta (365D) skipped: missing varC365");
  }
}

app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send("Missing shop");
  }

  const scopes = "write_draft_orders";

  // IMPORTANT: redirect must point back to THIS backend, not the store
  const redirectUri =
    "https://barterhex-proxy-backend.onrender.com/auth/callback";

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Invalid OAuth callback");
  }

  const tokenRes = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_APP_SECRET,
        code
      })
    }
  );

  const data = await tokenRes.json();

  if (!data.access_token) {
    return res.status(500).send("Token exchange failed");
  }

  console.log("OAuth successful. Set SHOPIFY_ADMIN_TOKEN in Render to:", data.access_token);
  res.send("App installed successfully. You may close this window.");

});

async function fetchCloseWithFallback(daysAgo, maxLookback = 10) {
  for (let i = 0; i <= maxLookback; i++) {
    const v = await fetchCloseForDate(dateMinus(daysAgo + i));
    if (Number.isFinite(v)) {
      if (i > 0) {
        console.log(
          `Fallback used for varC${daysAgo}: ${i} day(s) back`
        );
      }
      return v;
    }
  }

  console.log(
    `Fallback failed for varC${daysAgo}: no valid close within ${maxLookback} days`
  );
  return null;
}

function updateChartData() {
  calculateDeltas();
  cache.updatedAt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  ).toISOString();
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

  // Log the raw response data for debugging
  //console.log("fetchCloseForDate API Response: ", data);

  const day = Object.values(data?.rates || {})[0];
  const v = Number(day?.metals?.silver);
  return Number.isFinite(v) ? v : null;
}



/**
 * Fetch varE-day timeseries
 * - Populate calendar-based closes (ordered)
 * - Deduplicate array into vald closes (trading)
 * - Compute deduplicated median signal (varSm)
 */
async function fetchTimeseries() {
  console.log(
    "Max days worth of deduplicated data requested by varE:",
    varE
  );
   
  const url = new URL("https://api.metals.dev/v1/timeseries");
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("start_date", dateMinus(30));
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
    .map((date) => ({
      date,
      value: closesByDate[date]
    }));

  const trading = ordered.filter(
    (v, i, arr) => i === 0 || v.value !== arr[i - 1].value
  );

  console.log(
    "Days worth of data deduplicated from last 30 days:",
    trading.length
  );

  // Now, instead of just using the previous day's close for varC1,
  // we find the most recent close that doesn't match varS
  // AND skip Friday closes when market is closed
  
  let foundValidC1 = false;

  for (let i = trading.length - 1; i >= 0; i--) {
    const { date, value } = trading[i];
    
    // If market is closed, skip Friday closes
    if (cache.varMStatus === 0) {
      const day = new Date(date + "T00:00:00Z").getUTCDay(); // 5 = Friday
      if (day === 5) continue;
    }
    
    if (value !== cache.varS) {
      cache.varC1 = value;
      foundValidC1 = true;
      break;
    }
  }

  // Longer horizons with fallback (Without using median-calculating array defined by varE)
  cache.varC30  = await fetchCloseWithFallback(30);  // Fetch data for 30 days ago or further if null is returned.
  cache.varC365  = await fetchCloseWithFallback(365);;  // Fetch data for 365 days ago or further if null is returned.

  console.log("Fetched Historics:", cache.varC1, cache.varC30, cache.varC365);

  // Trigger delta calculation after fetching all historic close values
  calculateDeltas();

  // Set varSm
  //const slice = trading
  //  .slice(-Math.min(varE, trading.length))
  //  .map(v => v.value);
    
  //cache.varSm = round2(median(slice));
    cache.varSm = 83.51;
  //console.log("varSm set to:", cache.varSm, "(using", slice.length, "values)");
  //cache.ready = true;
  
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
  const S = Number((await res.json())?.rate?.price);
   
  if (!Number.isFinite(S)) return;
   
  cache.varS  = round2(S);
  cache.varSi = round2(S * varH);
  console.log("Fetched current spots (S,varS,varSi):", S, cache.varS, cache.varSi);
  
  updateMarketStatus(cache, cache.varS, fetchSpot);
  console.log('Market status is: ', cache.varMStatus);
}

/* -----------------------------
   SCHEDULING
-------------------------------- */

// Run immediately on deploy to fetch initial market data
(async () => {
  await fetchSpot();
  await fetchTimeseries();
  updateChartData();
})();

// Run daily at 6:10 Eastern Time to refresh timeseries data
cron.schedule("10 6 * * *", fetchTimeseries, { timezone: "America/New_York" });

// Refresh spot price every varF minutes
setInterval(async () => {
  await fetchSpot();
  updateChartData();
}, varF * 60 * 1000);

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
  const MAX_Q = 50;
  if (varQ > MAX_Q) {
    return res.status(400).json({ error: "quantity too large" });
  }

  // Ensure market data is ready
  if (!cache.ready) {
    return res.status(503).json({ error: "market data warming up" });
  }

   // Compute pricing
  const pricing = getPricing(cache, varQ);
  if (!pricing) {
    return res.status(503).json({ error: "pricing unavailable, varQ failure" });
  }

  // Success
  res.json(pricing);
});

/* -----------------------------
   DRAFT ORDER (CHECKOUT NOW)
-------------------------------- */

app.post("/proxy/draft-order", async (req, res) => {
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

  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!token) {
    return res.status(401).json({ error: "admin token missing" });
  }

  // 🔑 OAuth token lookup MUST be first
  const shop = req.query.shop || process.env.SHOPIFY_STORE_DOMAIN;

  // Parse + validate quantity
  const varQ = Number(req.body?.varQ);
  if (!Number.isFinite(varQ) || varQ <= 0) {
    return res.status(400).json({ error: "invalid quantity" });
  }

  // Ensure market data is ready
  if (!cache.ready) {
    return res.status(503).json({ error: "market data warming up" });
  }
   
  // Compute fresh pricing (source of truth)
  const pricing = getPricing(cache, varQ);
  if (!pricing || !Number.isFinite(pricing.varTu)) {
    return res.status(503).json({ error: "pricing unavailable" });
  }

  // Draft expiration timestamp
  const expiresAt = new Date(
    Date.now() + DRAFT_EXPIRY_MINUTES * 60 * 1000
  ).toISOString();

  try {
    const r = await fetch(
      `https://${shop}/admin/api/2024-01/draft_orders.json`,
      {
        method: "POST",
        headers: {
           "Content-Type": "application/json",
           "X-Shopify-Access-Token": token
        },
        body: JSON.stringify({
          draft_order: {
            line_items: [
              {
                title: "HexStack - 30xBarterHex",
                quantity: varQ,
                price: pricing.varTu
              }
            ],
            expires_at: expiresAt,
            use_customer_default_address: true
          }
        })
      }
    );

    const data = await r.json();

    const checkoutUrl =
      data?.draft_order?.invoice_url ||
      data?.draft_order?.checkout_url;

    if (!checkoutUrl) {
      return res.status(502).json({ error: "draft order failed" });
    }

    res.json({ checkout_url: checkoutUrl });

  } catch (err) {
    console.error("Draft order error:", err);
    res.status(500).json({ error: "server error" });
  }
});

/* -----------------------------
   START SERVER
-------------------------------- */

if (!process.env.SHOPIFY_ADMIN_TOKEN) {
  console.warn("SHOPIFY_ADMIN_TOKEN not set — checkout will fail");
}

// Start the backend server
app.listen(PORT, () => {
  console.log(`ENGINE backend running on port ${PORT}`);
});




