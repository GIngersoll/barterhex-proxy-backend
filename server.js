/**
 * ENGINE – Market Data Backend (Revised)
 *
 * Purpose:
 * - Fetch silver market data from metals.dev
 * - Cache calendar-based closes privately
 * - Compute derived market signals
 * - Expose a minimal, UI-safe market snapshot via Shopify App Proxy
 *
 * Public API:
 *   GET /proxy/market
 */

// -----------------------------
// CONFIGURATION
// -----------------------------

const varE = 7;        // Days used for median signal
const varF = 10;       // Spot refresh frequency (minutes)
const varH = 0.1;      // Troy ounces per token

// -----------------------------
// ENVIRONMENT
// -----------------------------

const API_KEY = process.env.PUBLISHER_API_KEY;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('Missing PUBLISHER_API_KEY');
  process.exit(1);
}

// -----------------------------
// IMPORTS
// -----------------------------

const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();

// -----------------------------
// CACHE (IN-MEMORY)
// -----------------------------

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

  varSm: null,

  updatedAt: null
};

// -----------------------------
// HELPERS
// -----------------------------

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

/**
 * Verify Shopify App Proxy signature (Shopify-spec correct)
 */
function verifyProxy(req) {
  if (!SHOPIFY_APP_SECRET) return true;

  const signature = req.query.signature;
  if (!signature) return false;

  // Remove signature and build canonical message
  const message = Object.keys(req.query)
    .filter(key => key !== 'signature')
    .sort()
    .map(key => `${key}=${req.query[key]}`)
    .join(''); // NOTE: no separators

  const digest = crypto
    .createHmac('sha256', SHOPIFY_APP_SECRET)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

// -----------------------------
// DATA FETCHERS
// -----------------------------

async function fetchTimeseries() {
  const url = new URL('https://api.metals.dev/v1/timeseries');
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('start_date', dateMinus(366));
  url.searchParams.set('end_date', fmtDate(new Date()));

  const res = await fetch(url);
  const data = await res.json();

  const rates = data?.rates || {};
  const closesByDate = {};

  for (const [date, obj] of Object.entries(rates)) {
    const v = Number(obj?.metals?.silver);
    if (Number.isFinite(v)) closesByDate[date] = v;
  }

  cache.varC1   = closesByDate[dateMinus(1)];
  cache.varC30  = closesByDate[dateMinus(30)];
  cache.varC365 = closesByDate[dateMinus(365)];

  const ordered = Object.keys(closesByDate)
    .sort()
    .map(d => closesByDate[d]);

  const trading = dedupeConsecutive(ordered);
  cache.varSm = median(trading.slice(-varE));
}

async function fetchSpot() {
  const url = new URL('https://api.metals.dev/v1/metal/spot');
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('metal', 'silver');
  url.searchParams.set('currency', 'USD');

  const res = await fetch(url);
  const data = await res.json();

  const S = Number(data?.rate?.price);
  if (!Number.isFinite(S)) return;

  cache.varS = S;
  cache.varSi = S * varH;

  if (cache.varC1 && cache.varC30 && cache.varC365) {
    cache.varCd  = S - cache.varC1;
    cache.varCdp = (cache.varCd / cache.varC1) * 100;

    cache.varCm  = S - cache.varC30;
    cache.varCmp = (cache.varCm / cache.varC30) * 100;

    cache.varCy  = S - cache.varC365;
    cache.varCyp = (cache.varCy / cache.varC365) * 100;
  }

  cache.updatedAt = new Date().toISOString();
}

// -----------------------------
// SCHEDULING
// -----------------------------

(async () => {
  await fetchTimeseries();
  await fetchSpot();
})();

cron.schedule('0 12 * * *', fetchTimeseries, { timezone: 'UTC' });
setInterval(fetchSpot, varF * 60 * 1000);

// -----------------------------
// SHOPIFY PROXY ENDPOINT (MUST COME BEFORE ANY BODY PARSERS)
// -----------------------------

app.get('/proxy/market', (req, res) => {
  if (!verifyProxy(req)) {
    return res.status(403).json({ error: 'invalid proxy signature' });
  }

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

// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {
  console.log(`ENGINE market backend running on port ${PORT}`);
});
