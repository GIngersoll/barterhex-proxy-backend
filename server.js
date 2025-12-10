/**
 * barterhex-proxy - Express backend for Shopify App Proxy
 *
 * - Calls metals.dev APIs (spot + timeseries) using server-side API key
 * - Caches results in memory
 * - Polls spot every SPOT_POLL_MIN minutes (default 15)
 * - Fetches historical timeseries daily (HISTORY_CRON, default 6:00 UTC)
 * - Exposes keyless endpoints used by Shopify App Proxy:
 *      GET /proxy/current  -> { S, updatedAt }
 *      GET /proxy/history  -> { history: [numbers], updatedAt }
 * - Verifies incoming Shopify App Proxy HMAC if SHOPIFY_APP_SECRET is set
 *
 * ENV vars:
 * - PUBLISHER_API_KEY    (required) — your metals.dev API key
 * - SHOPIFY_APP_SECRET   (recommended) — Shopify app secret for HMAC verification
 * - SPOT_POLL_MIN        (optional) — minutes between spot polls (default: 15)
 * - HISTORY_CRON         (optional) — cron string for daily history fetch (default: '0 6 * * *' = 06:00 UTC)
 * - HISTORY_DAYS         (optional) — default number of days to request for history (default: 7)
 * - PORT                 (optional) — port to listen on (default: 3000)
 *
 * Deploy notes:
 * - On Render set your environment variables in the service settings
 * - Use HTTPS (Render provides HTTPS)
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');
const helmet = require('helmet');

const app = express();
app.use(helmet());
app.use(express.json());

// --- CONFIG from ENV ---
const API_KEY = process.env.PUBLISHER_API_KEY;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET || '';
const SPOT_POLL_MIN = Number(process.env.SPOT_POLL_MIN || 15);
const HISTORY_CRON = process.env.HISTORY_CRON || '0 6 * * *'; // default 06:00 UTC daily
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 7);
const PORT = Number(process.env.PORT || 3000);

if (!API_KEY) {
  console.error('Missing required env: PUBLISHER_API_KEY');
  process.exit(1);
}

// metals.dev endpoints
const SPOT_URL = 'https://api.metals.dev/v1/metal/spot';
const TIMESERIES_URL = 'https://api.metals.dev/v1/timeseries';

// --- In-memory cache (sufficient for single-instance) ---
const cache = {
  spot: { S: null, raw: null, updatedAt: null },
  history: { history: [], updatedAt: null }
};

// --- Helpers ---
function fmtDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const a = arr.slice().sort((x,y)=>x-y);
  const n = a.length;
  if (n % 2 === 1) return a[(n-1)/2];
  // spec: if even, return the greater of the two median values
  return Math.max(a[n/2 - 1], a[n/2]);
}

// verify Shopify App Proxy HMAC signature if SHOPIFY_APP_SECRET provided
function verifyShopifyProxy(req) {
  if (!SHOPIFY_APP_SECRET) return true; // skip verification if secret not set
  try {
    // Shopify sends 'hmac' (or sometimes 'signature') in query
    const hmac = req.query.hmac || req.query.signature || req.headers['x-shopify-hmac-sha256'];
    if (!hmac) return false;

    // Build canonical query string (sorted by key) without the hmac/signature param
    const message = Object.keys(req.query)
      .filter(k => k !== 'hmac' && k !== 'signature')
      .sort()
      .map(k => `${k}=${req.query[k]}`)
      .join('&');

    const digest = crypto.createHmac('sha256', SHOPIFY_APP_SECRET).update(message).digest('hex');
    const digestBase64 = Buffer.from(digest, 'hex').toString('base64');

    // Support either base64 or hex variants from Shopify
    return hmac === digest || hmac === digestBase64;
  } catch (e) {
    console.error('HMAC verify error', e);
    return false;
  }
}

// --- Publisher API callers (server-side) ---
async function fetchSpotFromPublisher() {
  try {
    const resp = await axios.get(SPOT_URL, {
      params: { api_key: API_KEY, metal: 'silver', currency: 'USD' },
      timeout: 10000
    });
    const data = resp.data;
    // metals.dev current spot: data.rate.price
    const S = Number(data?.rate?.price);
    if (!Number.isFinite(S)) {
      console.warn('Spot response missing numeric price', data);
      return null;
    }
    cache.spot = { S, raw: data, updatedAt: new Date().toISOString() };
    console.log(`[${new Date().toISOString()}] Fetched spot: ${S}`);
    return cache.spot;
  } catch (err) {
    console.error('Error fetching spot:', err.message || err);
    return null;
  }
}

async function fetchHistoryFromPublisher(days = HISTORY_DAYS) {
  try {
    // compute start/end dates
    const end = new Date();
    const start = new Date(Date.now() - days * 24 * 3600 * 1000);

    const params = {
      api_key: API_KEY,
      start_date: fmtDate(start),
      end_date: fmtDate(end)
    };

    const resp = await axios.get(TIMESERIES_URL, { params, timeout: 15000 });
    const data = resp.data;
    // metals.dev: data.rates is an object keyed by date. metal value at .metals.silver
    const obj = data?.rates || {};
    const dates = Object.keys(obj).sort();
    const history = dates.map(d => Number(obj[d]?.metals?.silver)).filter(Number.isFinite);

    if (history.length === 0) {
      console.warn('History response had no usable silver values', data);
      return null;
    }

    cache.history = { history, updatedAt: new Date().toISOString() };
    console.log(`[${new Date().toISOString()}] Fetched history: ${history.length} points (from ${params.start_date} to ${params.end_date})`);
    return cache.history;
  } catch (err) {
    console.error('Error fetching history:', err.message || err);
    return null;
  }
}

// --- Initial fetches ---
(async function initialFetches(){
  await fetchSpotFromPublisher();
  await fetchHistoryFromPublisher(HISTORY_DAYS);
})();

// --- Schedulers ---
// Spot: poll every SPOT_POLL_MIN minutes via setInterval
setInterval(fetchSpotFromPublisher, Math.max(1, SPOT_POLL_MIN) * 60 * 1000);

// History: schedule per HISTORY_CRON (node-cron)
cron.schedule(HISTORY_CRON, () => {
  console.log('Running scheduled history fetch');
  fetchHistoryFromPublisher(HISTORY_DAYS);
}, { timezone: 'UTC' });

// --- Routes ---
// Health
app.get('/_health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), spotUpdated: cache.spot.updatedAt, historyUpdated: cache.history.updatedAt });
});

/**
 * GET /proxy/current
 * - Verifies Shopify proxy HMAC (if SHOPIFY_APP_SECRET provided)
 * - Returns { S, updatedAt }
 */
app.get('/proxy/current', (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(403).json({ error: 'invalid proxy signature' });
  if (!cache.spot.updatedAt) return res.status(503).json({ error: 'spot not available yet' });

  res.set('Cache-Control', 'public, max-age=60'); // small caching by CDN
  res.json({
    S: cache.spot.S,
    updatedAt: cache.spot.updatedAt
  });
});

/**
 * GET /proxy/history
 * Optional query param: days (overrides default HISTORY_DAYS)
 * Returns { history: [...], median: x, updatedAt }
 */
app.get('/proxy/history', (req, res) => {
  if (!verifyShopifyProxy(req)) return res.status(403).json({ error: 'invalid proxy signature' });

  // allow optional ?days=30 for on-demand
  const days = Math.max(1, Math.min(365, Number(req.query.days || HISTORY_DAYS)));

  // If cache is older than 24h and requested days differ, attempt a fresh fetch
  const needsFetch = !cache.history.updatedAt || (new Date() - new Date(cache.history.updatedAt)) > 24*3600*1000;
  if (needsFetch) {
    // try to fetch (async) and then respond with either updated cache or existing
    fetchHistoryFromPublisher(days).then(() => {
      const history = cache.history.history || [];
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ history, median: median(history), updatedAt: cache.history.updatedAt });
    }).catch(() => {
      const history = cache.history.history || [];
      res.json({ history, median: median(history), updatedAt: cache.history.updatedAt });
    });
    return;
  }

  // use cached
  const history = cache.history.history.slice(-days);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ history, median: median(history), updatedAt: cache.history.updatedAt });
});

// Fallback (small security: avoid advertising underlying stack)
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Start server
app.listen(PORT, () => {
  console.log(`barterhex-proxy listening on port ${PORT}`);
});
