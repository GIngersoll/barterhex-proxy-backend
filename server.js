/**
 * barterhex-proxy - Express backend for Shopify App Proxy
 *
 * - Calls metals.dev APIs (spot + timeseries) using server-side API key
 * - Caches results in memory
 * - Polls spot every SPOT_POLL_MIN minutes (default 15)
 * - Fetches historical timeseries daily (HISTORY_CRON, default 6:00 UTC)
 * - Exposes keyless endpoints used by Shopify App Proxy:
 *      GET /proxy/current
 *      GET /proxy/history
 * - Verifies Shopify App Proxy HMAC (2024/2025 format)
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
const SPOT_POLL_MIN = Number(process.env.SPOT_POLL_MIN || 15);
const HISTORY_CRON = process.env.HISTORY_CRON || '0 6 * * *';
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
  return d.toISOString().slice(0, 10);
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const a = arr.slice().sort((x,y)=>x-y)
