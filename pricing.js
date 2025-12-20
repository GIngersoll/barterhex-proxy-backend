// PRICING – HexStack backend pricing (authoritative)

const varA = 25.0;   // premium %, no discount
const varB = 15.0;   // premium %, max discount
const varC = 100;    // quantity for max discount
const varD = 1;      // quantity for no discount

const varG = 3.0;    // ounces per HexStack (backend truth)

/* ---------- helpers ---------- */

function truncate2(v) {
  return Number.isFinite(v)
    ? Math.trunc(v * 100) / 100
    : null;
}

function computeVarPf(varQ) {
  if (varQ <= varD) return varA / 100;
  if (varQ >= varC) return varB / 100;

  return (
    ((varA - varB) / 100) *
      (1 - (varQ - varD) / (varC - varD)) +
    (varB / 100)
  );
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
