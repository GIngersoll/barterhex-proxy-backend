/**
 * barterhex-proxy - Express backend for Shopify App Proxy
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const helmet = require('helmet');

const app = express();
app.use(helmet());
app.use(express.json());

// --- CONFIG ---
const API_KEY = process.env.PUBLISHER_API_KEY;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET || '';
const SPOT_POLL_MIN = Number(process.env.SPOT_POLL_MIN || 10);
const HISTORY_CRON = process.env.HISTORY_CRON || '30 7 * * *';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 7);
const PORT = Number(process.env.PORT || 3000);

if (!API_KEY) {
  console.error('Missing required env: PUBLISHER_API_KEY');
  process.exit(1);
}

// metals.dev endpoints
const SPOT_URL = 'https://api.metals.dev/v1/metal/spot';
const TIMESERIES_URL = 'https://api.metals.dev/v1/timeseries';

// --- Cache ---
const cache = {
  spot: { S: null, updatedAt: null },
  history: { history: [], updatedAt: null }
};

// --- Helpers ---
function fmtDate(d = new Date()) {
  return d.toISOString().slice(0, HISTORY_DAYS);
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const a = arr.slice().sort((x,y)=>x-y);
  const n = a.length;
  if (n % 2 === 1) return a[(n-1)/2];
  return Math.max(a[n/2 - 1], a[n/2]);
}

/**
 * Correct Shopify App Proxy signature verification (2024/2025)
 */
function verifyShopifyProxy(req) {
  if (!SHOPIFY_APP_SECRET) return true;

  try {
    const params = { ...req.query };
    const signature = params.signature;

    if (!signature) return false;
    delete params.signature;

    // Build sorted param string
    const sorted = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('');

    // HMAC using Shopify App Secret
    const computed = crypto
      .createHmac('sha256', SHOPIFY_APP_SECRET)
      .update(sorted)
      .digest('hex');

    return computed === signature;
  } catch (e) {
    console.error('Proxy verification error:', e);
    return false;
  }
}

// --- API fetchers ---
async function fetchSpotFromPublisher() {
  try {
    const r = await axios.get(SPOT_URL, {
      params: { api_key: API_KEY, metal: 'silver', currency: 'USD' },
      timeout: 10000
    });
    const price = Number(r.data?.rate?.price);
    if (!Number.isFinite(price)) return null;

    cache.spot = { S: price, updatedAt: new Date().toISOString() };
    console.log("Spot updated:", price);
    return cache.spot;
  } catch (err) {
    console.error("Spot fetch error:", err.message);
    return null;
  }
}

async function fetchHistoryFromPublisher(days = HISTORY_DAYS) {
  try {
    const end = new Date();
    const start = new Date(Date.now() - days * 24 * 3600 * 1000);

    const r = await axios.get(TIMESERIES_URL, {
      params: {
        api_key: API_KEY,
        start_date: fmtDate(start),
        end_date: fmtDate(end)
      },
      timeout: 15000
    });

    const raw = r.data?.rates || {};
    const dates = Object.keys(raw).sort();
    const history = dates
      .map(d => Number(raw[d]?.metals?.silver))
      .filter(Number.isFinite);

    cache.history = { history, updatedAt: new Date().toISOString() };
    console.log("History updated:", history.length, "days");
    return cache.history;
  } catch (err) {
    console.error("History fetch error:", err.message);
    return null;
  }
}

// --- Initial fetch ---
(async () => {
  await fetchSpotFromPublisher();
  await fetchHistoryFromPublisher(HISTORY_DAYS);
})();

// --- Schedulers ---
setInterval(fetchSpotFromPublisher, SPOT_POLL_MIN * 60 * 1000);

cron.schedule(HISTORY_CRON, () => {
  console.log("Daily history job triggered");
  fetchHistoryFromPublisher(HISTORY_DAYS);
}, { timezone: 'MST' });

// --- Routes ---
app.get('/_health', (req, res) => {
  res.json({
    ok: true,
    spotUpdated: cache.spot.updatedAt,
    historyUpdated: cache.history.updatedAt
  });
});

/**
 * /proxy/current
 */
app.get('/proxy/current', (req, res) => {
  if (!verifyShopifyProxy(req)) {
    return res.status(403).json({ error: 'invalid proxy signature' });
  }

  if (!cache.spot.updatedAt) {
    return res.status(503).json({ error: 'spot not available' });
  }

  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    S: cache.spot.S,
    updatedAt: cache.spot.updatedAt
  });
});

/**
 * /proxy/history
 */
app.get('/proxy/history', (req, res) => {
  if (!verifyShopifyProxy(req)) {
    return res.status(403).json({ error: 'invalid proxy signature' });
  }

  const days = Number(req.query.days || HISTORY_DAYS);
  const history = cache.history.history.slice(-days);

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    history,
    median: median(history),
    updatedAt: cache.history.updatedAt
  });
});

// Fallback
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Listen
app.listen(PORT, () => {
  console.log(`barterhex-proxy listening on port ${PORT}`);
});



