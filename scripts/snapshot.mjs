import { mkdir, writeFile } from 'node:fs/promises';
import { groupMarkets, VENUES } from '../site/lib/core.js';
const BASE = 'https://api-boros.pendle.finance/apis';
const get = async path => {
  const response = await fetch(BASE + path, { signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { data: await response.json(), fetchedAt: Date.now() };
};
const markets = [], syncStatuses = [], seen = new Set();
let cursor;
do {
  const params = new URLSearchParams({ isMatured: 'false', isUiWhitelisted: 'true', limit: '200' });
  if (cursor) params.set('resumeToken', cursor);
  const response = await get('/v1/markets?' + params);
  markets.push(...response.data.results); syncStatuses.push(response.data.syncStatus);
  cursor = response.data.resumeToken;
  if (cursor && seen.has(cursor)) throw new Error('Repeated cursor');
  seen.add(cursor);
  if (seen.size > 20) throw new Error('Too many market pages');
} while (cursor);
const assets = (await get('/v1/assets')).data.results;
const overview = { results: markets, assets, syncStatuses, fetchedAt: Date.now(), mode: 'snapshot' };
const groups = groupMarkets(markets, assets);
const bundle = { schemaVersion: 1, generatedAt: new Date().toISOString(), overview, books: {}, histories: {}, funding: {} };
const tasks = [];
for (const asset of ['BTC', 'ETH', 'HYPE']) {
  const eligible = groups.filter(g => g.underlying === asset && g.pairs.length);
  const group = eligible.find(g => g.maturity > Date.now() / 1000 + 3 * 86400) ?? eligible[0];
  const pair = group?.pairs.find(p => p.native) ?? group?.pairs[0];
  if (pair) {
    for (const m of [pair.a, pair.b, ...(pair.native ? [pair.native] : [])]) {
      tasks.push(async () => { bundle.books[m.marketId] = await get(`/v1/markets/order-book?marketId=${m.marketId}&tickSize=0.0001&includeAmm=true`); });
    }
    for (const m of [pair.a, pair.b]) {
      for (const days of [1, 7, 30]) tasks.push(async () => {
        bundle.histories[`${m.marketId}:${days}`] = await get(`/v1/indicators?marketId=${m.marketId}&timeFrame=${days === 30 ? '1d' : '1h'}&startTimestamp=${Math.floor(Date.now() / 1000 - days * 86400)}&select=mr`);
      });
    }
  }
  for (const venue of VENUES) tasks.push(async () => {
    const query = new URLSearchParams({ assetSymbol: asset, exchange: venue === 'KuCoin' ? 'Kucoin' : venue, timeFrame: '3600', startTimestamp: String(Math.floor(Date.now() / 1000 - 86400)) });
    bundle.funding[`${asset}:${venue}`] = await get(`/v1/markets/historical-underlying-apr?${query}`);
  });
}
const errors = [];
async function worker() {
  while (tasks.length) {
    const task = tasks.shift();
    try { await task(); } catch (error) { errors.push(error.message); }
  }
}
await Promise.all([worker(), worker(), worker()]);
bundle.optionalFailures = errors;
const out = new URL('../site/data/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('bootstrap.json', out), JSON.stringify(bundle) + '\n', 'utf8');
console.log(JSON.stringify({ generatedAt: bundle.generatedAt, markets: markets.length,
  pairs: groups.reduce((n, g) => n + g.pairs.length, 0), books: Object.keys(bundle.books).length,
  histories: Object.keys(bundle.histories).length, fundingSources: Object.keys(bundle.funding).length, optionalFailures: errors }, null, 2));
