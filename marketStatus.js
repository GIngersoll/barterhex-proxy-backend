/**
 * MARKET STATUS ENGINE
 *
 * Owns all logic related to:
 * - Scheduled market open / close
 * - Daily breaks
 * - Surprise market freeze detection
 *
 * This module:
 * - Does NOT fetch pricing data itself
 * - Operates only on passed-in cache
 * - Is the sole authority over cache.varMStatus
 */

const MARKET_CLOSED = 0;
const MARKET_OPEN   = 1;
const MARKET_BREAK  = 2;
const MARKET_FREEZE = 3;

/* -----------------------------
   MARKET SCHEDULE (ET)
-------------------------------- */

// Sunday open @ 6:00 PM ET
const varMOpen = new Date();
varMOpen.setHours(18, 0, 0, 0);

// Friday close @ 5:00 PM ET
const varMClose = new Date();
varMClose.setHours(17, 0, 0, 0);

// Monday–Thursday daily break
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
   HELPERS
-------------------------------- */

function getEastCoastTime(now = new Date()) {
  return new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

/**
 * Scheduled market status only
 * (ignores surprise freeze state)
 */
function getScheduledMarketStatus(now = new Date()) {
  const et = getEastCoastTime(now);
  const day = et.getDay(); // 0 = Sun, 6 = Sat

  // Monday–Thursday
  if (day >= 1 && day <= 4) {
    const onBreak  = varMOnBreak[day - 1];
    const offBreak = varMOffBreak[day - 1];

    if (et >= onBreak && et < offBreak) {
      return MARKET_BREAK;
    }
    return MARKET_OPEN;
  }

  // Friday
  if (day === 5) {
    if (et >= varMClose) return MARKET_CLOSED;
    return MARKET_OPEN;
  }

  // Sunday
  if (day === 0) {
    if (et >= varMOpen) return MARKET_OPEN;
    return MARKET_CLOSED;
  }

  // Saturday
  return MARKET_CLOSED;
}

/* -----------------------------
   SURPRISE FREEZE DETECTION
-------------------------------- */

async function lookForSurpriseClosure(cache, fetchSpot) {
  const prevSpot = cache.varS;

  console.log("Testing for surprise market closure in 2 minutes...");

  await new Promise(r => setTimeout(r, 2 * 60 * 1000));

  await fetchSpot();

  if (
    Number.isFinite(prevSpot) &&
    Number.isFinite(cache.varS) &&
    cache.varS === prevSpot
  ) {
    cache.varMStatus = MARKET_FREEZE;
    console.log("Surprise market closure detected.");
  }

  cache.alertmode = 0;
}

/* -----------------------------
   PUBLIC API
-------------------------------- */

/**
 * Single entry point for market status updates
 *
 * This function is the ONLY place that should mutate:
 * - cache.varMStatus
 * - cache.alertmode
 */
function updateMarketStatus(cache, currentSpot, fetchSpot) {
  const scheduledStatus = getScheduledMarketStatus();

  // If currently frozen, test exit conditions
  if (cache.varMStatus === MARKET_FREEZE) {
    if (
      cache.varS !== currentSpot &&
      scheduledStatus !== MARKET_CLOSED
    ) {
      cache.varMStatus = MARKET_OPEN;
      console.log("Spot change ended freeze");
      return;
    }

    if (scheduledStatus === MARKET_CLOSED) {
      cache.varMStatus = MARKET_CLOSED;
      console.log("Market close ended freeze");
      return;
    }

    // Stay frozen
    return;
  }

  // Detect potential surprise freeze
  if (
    scheduledStatus === MARKET_OPEN &&
    cache.varS === currentSpot &&
    cache.alertmode === 0
  ) {
    cache.alertmode = 1;
    lookForSurpriseClosure(cache, fetchSpot);
  }

  // Normal scheduled state
  cache.varMStatus = scheduledStatus;
}

module.exports = {
  updateMarketStatus,

  // exported for clarity / testing
  MARKET_CLOSED,
  MARKET_OPEN,
  MARKET_BREAK,
  MARKET_FREEZE
};
