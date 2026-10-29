export const YEAR = 365 * 86400;
export const VENUES = ['Hyperliquid', 'Binance', 'OKX', 'Gate', 'KuCoin', 'Lighter', 'Bybit', 'Bitget', 'Deribit'];
export const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const subtract = (a, b) => isNumber(a) && isNumber(b) ? a - b : null;
export const normalize = value => String(value ?? '').trim().toLowerCase();
export const venueIndex = m => {
  const n = VENUES.findIndex(v => normalize(v) === normalize(m.platform.platformId));
  return n < 0 ? 100 : n;
};
export function activeMarkets(markets, now = Date.now() / 1000) {
  return markets.filter(m => m.metadata?.isUiWhitelisted === true && m.config?.status === 2 && m.imData?.maturity > now);
}
export function groupMarkets(markets, assets, now = Date.now() / 1000) {
  const active = activeMarkets(markets, now);
  const tokens = new Map(assets.filter(a => a.isCollateral).map(a => [a.tokenId, a]));
  const groups = new Map();
  for (const m of active.filter(m => m.metadata.isSpreadMarket === false)) {
    if (!tokens.has(m.tokenId)) continue;
    const key = `${m.metadata.underlyingSymbol}:${m.tokenId}:${m.imData.maturity}`;
    if (!groups.has(key)) groups.set(key, {
      key, underlying: m.metadata.underlyingSymbol, tokenId: m.tokenId,
      asset: tokens.get(m.tokenId), maturity: m.imData.maturity, markets: [], native: [],
    });
    groups.get(key).markets.push(m);
  }
  for (const group of groups.values()) {
    group.markets.sort((a, b) => venueIndex(a) - venueIndex(b) || a.marketId - b.marketId);
    group.native = active.filter(m => m.metadata.isSpreadMarket === true && m.tokenId === group.tokenId && m.imData.maturity === group.maturity && m.metadata.underlyingSymbol === group.underlying);
    group.pairs = [];
    group.markets.forEach((a, i) => group.markets.slice(i + 1).forEach(b => {
      if (normalize(a.platform.platformId) === normalize(b.platform.platformId)) return;
      const native = group.native.find(m => m.platform.platformId === `${normalize(a.platform.platformId)}-${normalize(b.platform.platformId)}`);
      group.pairs.push({
        id: `${a.marketId}-${b.marketId}`, group, a, b, native: native ?? null,
        mid: subtract(a.data.midApr, b.data.midApr),
        bid: subtract(a.data.bestBid, b.data.bestAsk),
        ask: subtract(a.data.bestAsk, b.data.bestBid),
        floatingReference: subtract(a.data.floatingApr, b.data.floatingApr),
      });
    }));
  }
  return [...groups.values()].sort((a, b) => a.underlying.localeCompare(b.underlying) || a.tokenId - b.tokenId || a.maturity - b.maturity);
}
export function decimalRaw(value, precision = 18) {
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('金额格式无效');
  const [integer, fractional = ''] = text.split('.');
  if (fractional.length > precision && /[1-9]/.test(fractional.slice(precision))) throw new Error('金额精度过高');
  return BigInt(integer) * 10n ** BigInt(precision) + BigInt(fractional.slice(0, precision).padEnd(precision, '0'));
}
export function notionalToYu(usd, price) {
  const amount = decimalRaw(usd), px = decimalRaw(price);
  if (amount <= 0n || px <= 0n) throw new Error('名义金额和抵押币价格必须大于零');
  return (amount * 10n ** 18n + px - 1n) / px;
}
export function walkBook(book, action, requestedRaw, tickSize = 0.0001) {
  const side = action === 'short' ? book?.long : book?.short;
  if (!side || !Array.isArray(side.ia) || !Array.isArray(side.sz) || side.ia.length !== side.sz.length) return null;
  let left = requestedRaw, filled = 0n, weighted = 0, worst = null;
  if (requestedRaw <= 0n) return null;
  for (let i = 0; i < side.ia.length && left > 0n; i++) {
    if (!isNumber(side.ia[i]) || !/^\d+$/.test(side.sz[i])) return null;
    const available = BigInt(side.sz[i]);
    const take = available < left ? available : left;
    if (take === 0n) continue;
    const rate = side.ia[i] * tickSize;
    filled += take; left -= take;
    weighted += Number(take) / Number(requestedRaw) * rate;
    worst = rate;
  }
  return { full: left === 0n, filledRaw: filled.toString(), requestedRaw: requestedRaw.toString(),
    fraction: Number(filled) / Number(requestedRaw), apr: filled > 0n ? weighted / (Number(filled) / Number(requestedRaw)) : null, worst };
}
const rate18 = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(BigInt(value)) / 1e18 : null;
export function estimatePair(pair, books, usd, direction, now = Date.now() / 1000) {
  const price = pair.group.asset.usdPrice;
  let size;
  try { size = notionalToYu(usd, price); } catch (error) { return { error: error.message }; }
  const a = books.get(pair.a.marketId), b = books.get(pair.b.marketId);
  const actionA = direction === 'short' ? 'short' : 'long';
  const actionB = direction === 'short' ? 'long' : 'short';
  const qa = walkBook(a?.data, actionA, size), qb = walkBook(b?.data, actionB, size);
  const full = qa?.full === true && qb?.full === true;
  const apr = full ? qa.apr - qb.apr : null;
  const stamps = [a?.data.syncStatus?.timestamp, b?.data.syncStatus?.timestamp];
  const fresh = stamps.every(isNumber) && stamps.every(t => now - t <= 120 && t - now <= 30) && Math.abs(stamps[0] - stamps[1]) <= 30 && a?.mode === 'live' && b?.mode === 'live';
  const duration = Math.max(0, pair.group.maturity - now) / YEAR;
  const feeA = rate18(pair.a.config.takerFee), feeB = rate18(pair.b.config.takerFee);
  const carryA = rate18(pair.a.extConfig.settleFeeRate), carryB = rate18(pair.b.extConfig.settleFeeRate);
  const feeKnown = [feeA, feeB, carryA, carryB].every(isNumber);
  // Fees use each market's last funding boundary, matching upfront accounting.
  const tenor = m => Math.max(0, m.imData.maturity - (m.data.nextSettlementTime - m.extConfig.paymentPeriod)) / YEAR;
  const costUsd = feeKnown ? Number(usd) * (feeA * tenor(pair.a) + feeB * tenor(pair.b) + (carryA + carryB) * duration) : null;
  const fixedCashUsd = full ? Number(usd) * (direction === 'short' ? apr : -apr) * duration : null;
  return { qa, qb, full, apr, fresh, actionA, actionB, costUsd, fixedCashUsd,
    yu: Number(size) / 1e18, years: duration, feeKnown,
    amm: [pair.a, pair.b].some(m => m.extConfig.ammAddress && !/^0x0+$/.test(m.extConfig.ammAddress)),
    syncSkew: stamps.every(isNumber) ? Math.abs(stamps[0] - stamps[1]) : null };
}
export function alignedHistory(a, b) {
  const map = new Map((b?.results ?? []).map(row => [row.ts, row]));
  return (a?.results ?? []).flatMap(row => {
    const other = map.get(row.ts);
    if (!other || !isNumber(row.mr) || !isNumber(other.mr)) return [];
    return [{ ts: row.ts, value: row.mr - other.mr }];
  });
}
export function historyStats(series) {
  const values = series.map(r => r.value).filter(isNumber);
  if (!values.length) return { mean: null, min: null, max: null, percentile: null };
  const mean = values.reduce((s, n) => s + n, 0) / values.length;
  const last = values.at(-1);
  return { mean, min: Math.min(...values), max: Math.max(...values), percentile: values.filter(v => v <= last).length / values.length };
}
export function csvText(rows) {
  const cell = value => `"${(typeof value === 'string' ? value.replace(/^[=+@\-]/, "'$&") : String(value ?? '')).replaceAll('"', '""')}"`;
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
