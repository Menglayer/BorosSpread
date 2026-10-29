import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Offline analysis of the recorded public API responses. No wallet or trade calls.
const root = new URL('../', import.meta.url);
const read = async (name) => JSON.parse((await readFile(new URL(`research/${name}`, root), 'utf8')).replace(/^\uFEFF/, ''));
const [snapshot, assets, settlements, symbols, schema] = await Promise.all([
  read('boros-markets.snapshot.json'), read('assets.snapshot.json'),
  read('settlements.snapshot.json'), read('funding-symbols.snapshot.json'),
  read('schema-version.json'),
]);
if (!snapshot.complete) throw new Error('Market pagination is incomplete.');
const asOf = Date.parse(snapshot.fetchedAt) / 1000;
if (!Number.isFinite(asOf)) throw new Error('Invalid snapshot timestamp.');
const tokenById = new Map(assets.results.filter((a) => a.isCollateral).map((a) => [a.tokenId, a]));
const venueKey = (name) => name.trim().toLowerCase();
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const difference = (a, b) => finite(a) && finite(b) ? a - b : null;
const live = snapshot.results.filter((m) => m.metadata.isUiWhitelisted === true && m.imData.maturity > asOf);
const eligible = live.filter((m) => m.config.status === 2);
const singles = eligible.filter((m) => m.metadata.isSpreadMarket === false);
const native = eligible.filter((m) => m.metadata.isSpreadMarket === true);
const groups = new Map();
for (const market of singles) {
  if (!tokenById.has(market.tokenId)) throw new Error(`Unknown collateral for market ${market.marketId}`);
  const key = `${market.metadata.underlyingSymbol}:${market.tokenId}:${market.imData.maturity}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(market);
}
const groupRows = [];
const pairs = [];
for (const [key, markets] of groups) {
  markets.sort((a, b) => venueKey(a.platform.platformId).localeCompare(venueKey(b.platform.platformId)) || a.marketId - b.marketId);
  const [first] = markets;
  let pairCount = 0;
  for (let i = 0; i < markets.length; i++) for (let j = i + 1; j < markets.length; j++) {
    const a = markets[i], b = markets[j];
    if (venueKey(a.platform.platformId) === venueKey(b.platform.platformId)) continue;
    pairs.push({
      id: `${a.marketId}-${b.marketId}`, group: key,
      legA: { marketId: a.marketId, venue: a.platform.name },
      legB: { marketId: b.marketId, venue: b.platform.name },
      referenceMidSpreadApr: difference(a.data.midApr, b.data.midApr),
      referenceMarkSpreadApr: difference(a.data.markApr, b.data.markApr),
      // These two floating observations may describe different funding windows.
      unalignedFloatingDifferenceApr: difference(a.data.floatingApr, b.data.floatingApr),
      referenceShortSpreadApr: difference(a.data.bestBid, b.data.bestAsk),
      referenceLongSpreadApr: difference(a.data.bestAsk, b.data.bestBid),
      classification: 'matched-candidate-not-size-validated',
    });
    pairCount++;
  }
  groupRows.push({
    key, underlying: first.metadata.underlyingSymbol,
    collateralTokenId: first.tokenId, collateral: tokenById.get(first.tokenId).symbol,
    maturity: first.imData.maturity, maturityUtc: new Date(first.imData.maturity * 1000).toISOString(),
    venues: markets.map((m) => m.platform.name), marketIds: markets.map((m) => m.marketId), pairCount,
  });
}
groupRows.sort((a, b) => a.underlying.localeCompare(b.underlying) || a.collateralTokenId - b.collateralTokenId || a.maturity - b.maturity);

const nativeComparisons = native.map((m) => {
  // Explicitly support the live HL-Gate oracle definition; do not guess new definitions.
  if (m.platform.platformId !== 'hyperliquid-gate') return { marketId: m.marketId, status: 'unmapped-oracle-definition' };
  const match = (venue) => singles.find((s) => s.tokenId === m.tokenId && s.imData.maturity === m.imData.maturity &&
    s.metadata.underlyingSymbol === m.metadata.underlyingSymbol && venueKey(s.platform.platformId) === venue);
  const a = match('hyperliquid'), b = match('gate');
  if (!a || !b) return { marketId: m.marketId, status: 'missing-matching-leg' };
  const syntheticBid = difference(a.data.bestBid, b.data.bestAsk);
  const syntheticAsk = difference(a.data.bestAsk, b.data.bestBid);
  return {
    marketId: m.marketId, name: m.imData.name, legAMarketId: a.marketId, legBMarketId: b.marketId,
    nativeBidApr: m.data.bestBid ?? null, nativeAskApr: m.data.bestAsk ?? null,
    syntheticBidApr: syntheticBid, syntheticAskApr: syntheticAsk,
    sellNativeBuySyntheticReferenceApr: difference(m.data.bestBid, syntheticAsk),
    sellSyntheticBuyNativeReferenceApr: difference(syntheticBid, m.data.bestAsk),
    classification: 'reference-before-fees-depth-and-epoch-adjustments',
  };
});

// Reconcile observed settlement prints for BTC Nov 2026. The timestamp alignment
// below is empirically verified on this snapshot, not a universal schema promise.
const events = settlements.settlementMarketSummaries;
const reconciliation = [];
for (const spread of events.filter((r) => r.marketId === 233)) {
  const timestamp = spread.periodTimestamp;
  const gate = events.find((r) => r.marketId === 222 && r.periodTimestamp === timestamp);
  const hl = events.filter((r) => r.marketId === 220 && r.periodTimestamp > timestamp - 28800 && r.periodTimestamp <= timestamp);
  if (!gate || hl.length !== 8) continue;
  const derivedApr = hl.reduce((s, r) => s + r.settlementApr, 0) / 8 - gate.settlementApr;
  reconciliation.push({ timestamp, hlPrints: hl.length, derivedApr, nativeApr: spread.settlementApr, residualApr: derivedApr - spread.settlementApr });
}
if (!reconciliation.length || reconciliation.some((r) => Math.abs(r.residualApr) > 1e-10)) {
  throw new Error('Sample settlement reconciliation failed.');
}

// Illustrative size checks from the four sampled books. Bucketed APR is an
// estimate: API ia * tickSize, NOT the exponential on-chain raw tick mapping.
const depthSamples = [];
for (const marketId of [220, 221, 222, 233]) {
  const market = singles.concat(native).find((m) => m.marketId === marketId);
  const book = await read(`book-${marketId}.snapshot.json`);
  const amount = 10n ** 18n; // 1 YU in collateral units, NOT 1 BTC on USDt0 markets.
  for (const side of ['long', 'short']) {
    const levels = book[side];
    let remaining = amount, filled = 0n, weighted = 0;
    for (let i = 0; i < levels.ia.length && remaining > 0n; i++) {
      const available = BigInt(levels.sz[i]);
      const take = available < remaining ? available : remaining;
      if (take < 0n) throw new Error('Negative book size.');
      filled += take;
      remaining -= take;
      weighted += (Number(take) / 1e18) * levels.ia[i] * 0.0001;
    }
    depthSamples.push({ marketId, collateral: tokenById.get(market.tokenId).symbol,
      takerAction: side === 'long' ? 'short-YU-hit-bids' : 'long-YU-lift-asks',
      requestedYu: '1', filledRaw: filled.toString(), full: remaining === 0n,
      approximateFilledApr: filled > 0n ? weighted / (Number(filled) / 1e18) : null,
      syncStatus: book.syncStatus, classification: 'bucketed-depth-estimate-not-simulation',
    });
  }
}

const output = {
  asOf: snapshot.fetchedAt, schemaVersion: schema.version,
  totalHistoricalAndCurrentMarkets: snapshot.results.length,
  pages: snapshot.pageCount, syncStatuses: snapshot.syncStatuses,
  futureUiMarkets: live.length, normalFundingMarkets: singles.length, normalNativeSpreadMarkets: native.length,
  fundingVenues: [...new Set(singles.map((m) => m.platform.name))].sort(),
  fundingRateSymbols: symbols.fundingRateSymbols.length,
  underlyingObservationVenues: [...new Set(symbols.fundingRateSymbols.filter((s) => !s.fundingRateSymbol.startsWith('spread-')).map((s) => s.exchange))].sort(),
  candidateUnorderedPairs: pairs.length, candidateDirections: pairs.length * 2,
  groups: groupRows, pairs, nativeComparisons, settlementReconciliation: reconciliation, depthSamples,
  limitations: ['Snapshot is not a live feed.', 'Candidate count is not executable opportunity count.',
    'Floating observations require epoch alignment.', 'Depth samples are separate snapshots and have no atomic execution guarantee.',
    'No wallet, trade, full-history, or account-margin validation was performed.'],
};
const destination = new URL('research/coverage-analysis.json', root);
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ asOf: output.asOf, schemaVersion: output.schemaVersion,
  totalMarkets: snapshot.results.length, fundingMarkets: singles.length, nativeMarkets: native.length,
  candidatePairs: pairs.length, directions: pairs.length * 2,
  reconciledSettlementWindows: reconciliation.length, output: fileURLToPath(destination) }, null, 2));
