function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

/**
 * Prices one usage record from provider-reported cost only. Reviewer captures
 * carry pi's catalog estimate separately; there is no local price table, so an
 * unreported cost stays unavailable rather than becoming a guess.
 */
export function priceUsage({ reportedCostUsd = null }) {
  if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
    const reported = toNumber(reportedCostUsd);
    return {
      costUsd: reported,
      label: formatCost(reported),
      rawReportedCostUsd: reported,
      source: "provider",
    };
  }
  return {
    costUsd: null,
    label: "n/a",
    rawReportedCostUsd: 0,
    source: "unavailable",
  };
}
