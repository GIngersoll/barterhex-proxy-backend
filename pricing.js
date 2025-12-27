// PRICING – HexStack backend pricing (authoritative)

const varA = 35.0;   // premium %, no discount
const varB = 15.0;   // premium %, max discount
const varC = 50;    // quantity for max discount
const varD = 1;      // quantity for no discount
const varX = 2.2;    // discount curve exponent: higher = more aggressive early discount

const varG = 3.0;    // ounces per HexStack (backend truth)

/* ---------- helpers ---------- */

function truncate2(v) {
  return Number.isFinite(v)
    ? Math.trunc(v * 100) / 100
    : null;
}

function computeVarPf(varQ) {
  // Bounds
  if (varQ <= varD) return varA / 100;
  if (varQ >= varC) return varB / 100;

  // Normalize quantity to [0, 1]
  const t = (varQ - varD) / (varC - varD);

  /*
    Curved (parabolic / power) discount model
    curve = 1 - (1 - t)^varX

    varX controls aggressiveness:
      2.0  -> conservative (quadratic)
      2.5  -> balanced (recommended)
      3.0+ -> aggressive early discount
  */
  const curve = 1 - Math.pow(1 - t, varX);

  // Interpolate premium from varA → varB
  return (varA - (varA - varB) * curve) / 100;
}

/* ---------- main ---------- */

function getPricing(cache, varQ) {
  if (!Number.isFinite(varQ) || varQ <= 0) return null;

  const { varS, varSm } = cache;
  if (!Number.isFinite(varS) || !Number.isFinite(varSm)) return null;

  // Conditional spot floor
  const varSc = Math.max(varS, varSm);

  // Premium factor (decimal)
  const varPf = computeVarPf(varQ);

  // Unit price (authoritative)
  const rawTu = varSc * (1 + varPf) * varG;
  const varTu = truncate2(rawTu);

  // Total (authoritative)
  const varTd = truncate2(varTu * varQ);

  return {
    varTu,
    varTd
  };
}

module.exports = { getPricing };
