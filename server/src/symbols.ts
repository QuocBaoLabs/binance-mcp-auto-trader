export function normalizeUsdFuturesSymbol(value: string): string {
  let raw = value.trim().toUpperCase();
  if (raw.includes(":")) raw = raw.split(":").pop() ?? raw;
  raw = raw.replace(/\.P(ERP)?$/, "").replace(/PERP$/, "");
  const compact = raw.replace(/[^A-Z0-9]/g, "");
  if (!compact) return "";
  return compact.endsWith("USDT") ? compact : `${compact}USDT`;
}

export function normalizeUsdFuturesSymbols(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeUsdFuturesSymbol).filter(Boolean))
  );
}
