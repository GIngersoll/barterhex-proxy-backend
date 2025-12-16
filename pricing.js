function getPricing(cache) {
  return {
    spot: cache.varS,
    delta: cache.varCd,
    deltaPct: cache.varCdp
  };
}

module.exports = { getPricing };
