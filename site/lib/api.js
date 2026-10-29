export const BASE = 'https://api-boros.pendle.finance/apis';
const memory = new Map();
const inflight = new Map();
let blockedUntil = 0;
export function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(`boros:${key}`)); } catch { return null; }
}
export function cacheSet(key, value) {
  try { localStorage.setItem(`boros:${key}`, JSON.stringify(value)); } catch { /* Cache is optional. */ }
}
export async function request(path, ttl = 60000) {
  const old = memory.get(path);
  if (old && Date.now() - old.fetchedAt < ttl) return old;
  if (inflight.has(path)) return inflight.get(path);
  const task = (async () => {
    if (Date.now() < blockedUntil) throw new Error('官方接口暂时限流，请稍后刷新');
    const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(14000), credentials: 'omit' });
    if (response.status === 429) { blockedUntil = Date.now() + 60000; throw new Error('官方接口限流，已暂停请求 60 秒'); }
    if (!response.ok) throw new Error(`行情接口返回 ${response.status}`);
    const data = await response.json();
    const result = { data, fetchedAt: Date.now(), mode: 'live' };
    memory.set(path, result);
    return result;
  })().finally(() => inflight.delete(path));
  inflight.set(path, task);
  return task;
}
export async function fetchOverview(force = false) {
  let cursor = null, results = [], syncStatuses = [];
  const seen = new Set();
  do {
    const query = new URLSearchParams({ isMatured: 'false', isUiWhitelisted: 'true', limit: '200' });
    if (cursor) query.set('resumeToken', cursor);
    const response = await request(`/v1/markets?${query}`, force ? 0 : 50000);
    if (!Array.isArray(response.data.results)) throw new Error('市场数据结构无效');
    results.push(...response.data.results);
    syncStatuses.push(response.data.syncStatus);
    cursor = response.data.resumeToken;
    if (cursor && seen.has(cursor)) throw new Error('市场分页出现重复游标');
    seen.add(cursor);
    if (seen.size > 20) throw new Error('市场分页超过安全上限');
  } while (cursor);
  const assets = await request('/v1/assets', force ? 0 : 50000);
  const result = { results, assets: assets.data.results, syncStatuses, fetchedAt: Date.now(), mode: 'live' };
  cacheSet('overview', result);
  return result;
}
export const fetchBook = (id, force = false) => request(`/v1/markets/order-book?marketId=${id}&tickSize=0.0001&includeAmm=true`, force ? 0 : 50000);
export async function fetchHistory(id, days) {
  const timeFrame = days === 30 ? '1d' : '1h';
  const start = Math.floor(Date.now() / 1000 - days * 86400);
  // Round the cache key to a 5-minute bucket so repeated selections share reads.
  const rounded = Math.floor(start / 300) * 300;
  return request(`/v1/indicators?marketId=${id}&timeFrame=${timeFrame}&startTimestamp=${rounded}&select=mr`, 300000);
}
export async function fetchUnderlying(asset, exchange) {
  const start = Math.floor((Date.now() / 1000 - 86400) / 3600) * 3600;
  const query = new URLSearchParams({ assetSymbol: asset, exchange: exchange === 'KuCoin' ? 'Kucoin' : exchange, timeFrame: '3600', startTimestamp: String(start) });
  return request(`/v1/markets/historical-underlying-apr?${query}`, 300000);
}
