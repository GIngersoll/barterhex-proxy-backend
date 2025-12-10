/**
 * BarterHex Shopify App Proxy Backend
 * FINAL VERSION — Fully adapted for api.metals.dev
 *
 * Securely provides:
 *  /proxy/current  → { S }
 *  /proxy/history  → { history[] }
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const helmet = require('helmet');

const app = express();
app.use(helmet());
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG (ENVIRONMENT VARIABLES)
// ---------------------------------------------------------------------------
const API_KEY = process.env.PUBLISHER_API_KEY;            // required
const SPOT_URL = "https://api.metals.dev/v1/metal/spot";
const HISTORY_URL = "https://api.metals.dev/v1/timeseries";

const SPOT_POLL_MIN = Number(process.env.SPOT_POLL_MIN || 15);
const HISTORY_CRON = process.env.HISTORY_CRON || "0 6 * * *";  // 6AM daily
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET || "";

if (!API_KEY) {
  console.error("ERROR: Missing PUBLISHER_API_KEY.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CACHE
// ---------------------------------------------------------------------------
const cache = {
  spot: { S: null, updatedAt: null, raw: null },
  history: { history: [], updatedAt: null }
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
async function fetchSpot() {
  try {
    const resp = await axios.get(SPOT_URL, {
      params: {
        api_key: API_KEY,
        metal: "silver",
        currency: "USD"
      }
    });

    const data = resp.data;

    // Your API’s current spot price is located at:
    // result.rate.price
    const S = Number(data?.rate?.price);

    if (!Number.isFinite(S)) {
      console.error("Spot API response missing numeric price:", data);
      return;
    }

    cache.spot = {
      S,
      updatedAt: new Date().toISOString(),
      raw: data
    };

    console.log(`Fetched spot S=${S}`);
  } catch (err) {
    console.error("Error fetching spot:", err.message);
  }
}

async function fetchHistory() {
  try {
    // We must compute start/end dates based on E (days)
    const E = Number(process.env.HISTORY_DAYS || 7); // default 7, replace with Shopify section value later

    const end = new Date();
    const start = new Date(Date.now() - E * 24 * 3600 * 1000);

    const fmt = d => d.toISOString().slice(0, 10);

    const resp = await axios.get(HISTORY_URL, {
      params: {
        api_key: API_KEY,
        start_date: fmt(start),
        end_date: fmt(end)
      }
    });

    const data = resp.data;

    // Your API’s historical silver price for each day is:
    // rates[date].metals.silver
    const obj = data?.rates || {};
    const days = Object.keys(obj).sort();

    const history = days.map(d =>
      Number(obj[d]?.metals?.silver)
    ).filter(Number.isFinite);

    if (history.length === 0) {
      console.error("History API returned no usable silver data:", data);
      return;
    }

    cache.history = {
      history,
      updatedAt: new Date().toISOString()
    };

    console.log(`Fetched ${history.length} days of history`);
  } catch (err) {
    console.error("Error fetching history:", err.message);
  }
}

// Shopify App Proxy Signature verification
function verifyProxy(req) {
  if (!SHOPIFY_APP_SECRET) return true;

  const hmac = req.query.hmac || req.query.signature;
  if (!hmac) return false;

  const msg = Object.keys(req.query)
    .filter(k => k !== "hmac" && k !== "signature")
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_APP_SECRET)
    .update(msg)
    .digest("hex");

  const digestBase64 = Buffer.from(digest, "hex").toString("base64");

  // Shopify may send hex OR base64
  return hmac === digest || hmac === digestBase64;
}

// ---------------------------------------------------------------------------
// PROXY ENDPOINTS
// ---------------------------------------------------------------------------
app.get("/proxy/current", (req, res) => {
  if (!verifyProxy(req)) return res.status(403).json({ error: "invalid signature" });

  if (!cache.spot.S) return res.status(503).json({ error: "spot unavailable" });

  res.json({
    S: cache.spot.S,
    updatedAt: cache.spot.updatedAt
  });
});

app.get("/proxy/history", (req, res) => {
  if (!verifyProxy(req)) return res.status(403).json({ error: "invalid signature" });

  if (!cache.history.history.length) {
    return res.status(503).json({ error: "history unavailable" });
  }

  res.json({
    history: cache.history.history,
    updatedAt: cache.history.updatedAt
  });
});

// ---------------------------------------------------------------------------
// SCHEDULERS
// ---------------------------------------------------------------------------
(async function boot() {
  await fetchSpot();
  await fetchHistory();

  // Spot price every F minutes
  setInterval(fetchSpot, SPOT_POLL_MIN * 60 * 1000);

  // History daily at 6AM (configurable)
  cron.schedule(HISTORY_CRON, fetchHistory, {
    timezone: "UTC"
  });

  console.log("Schedulers initialized.");
})();

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`BarterHex proxy backend running on port ${PORT}`)
);
