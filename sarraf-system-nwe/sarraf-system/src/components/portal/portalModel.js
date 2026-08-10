export function portalRouteFromHash(hash, role, allowed, fallback) {
  const match = String(hash || "").match(/^#\/portal\/(customer|partner)\/([a-z-]+)$/);
  return match?.[1] === role && allowed.includes(match[2]) ? match[2] : fallback;
}

export function separatedCurrencySummary(positive = {}, negative = {}) {
  const currencyIds = [...new Set([...Object.keys(positive), ...Object.keys(negative)])]
    .filter((id) => Number(positive[id] || 0) !== 0 || Number(negative[id] || 0) !== 0);
  if (currencyIds.length !== 1) return { currencyIds, currencyId: null, amount: null };
  const currencyId = currencyIds[0];
  return { currencyIds, currencyId, amount: Number(positive[currencyId] || 0) - Number(negative[currencyId] || 0) };
}
