import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { groupMarkets, activeMarkets, notionalToYu, walkBook, estimatePair, alignedHistory, csvText } from '../site/lib/core.js';
const read = async name => JSON.parse((await readFile(new URL(`../research/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const snapshot = await read('boros-markets.snapshot.json');
const assets = (await read('assets.snapshot.json')).results;
const at = Date.parse(snapshot.fetchedAt) / 1000;
const groups = groupMarkets(snapshot.results, assets, at);
test('real snapshot: only compatible normal markets form the 94 unique candidates', () => {
  const pairs = groups.flatMap(g => g.pairs);
  assert.equal(pairs.length, 94);
  assert.equal(new Set(pairs.map(p => p.id)).size, 94);
  assert.equal(pairs.filter(p => p.native).length, 4);
  for (const p of pairs) {
    assert.equal(p.a.tokenId, p.b.tokenId);
    assert.equal(p.a.imData.maturity, p.b.imData.maturity);
    assert.equal(p.a.metadata.underlyingSymbol, p.b.metadata.underlyingSymbol);
    assert.notEqual(p.a.platform.platformId, p.b.platform.platformId);
    assert.equal(p.a.config.status, 2);
    assert.equal(p.b.config.status, 2);
  }
});
test('expired, paused, and non-UI markets cannot enter candidates', () => {
  const m = structuredClone(snapshot.results.find(m => m.marketId === 220));
  assert.equal(activeMarkets([m], at).length, 1);
  m.config.status = 1; assert.equal(activeMarkets([m], at).length, 0);
  m.config.status = 0; assert.equal(activeMarkets([m], at).length, 0);
  m.config.status = 2; m.metadata.isUiWhitelisted = false; assert.equal(activeMarkets([m], at).length, 0);
  m.metadata.isUiWhitelisted = true; assert.equal(activeMarkets([m], m.imData.maturity).length, 0);
});
test('USD amount maps to collateral YU, using exact integer rounding', () => {
  assert.equal(notionalToYu('10000', '80000'), 125000000000000000n);
  assert.equal(notionalToYu('10000', '1'), 10000n * 10n ** 18n);
  assert.equal(notionalToYu('1', '3'), 333333333333333334n);
  for (const value of ['0', '-1', 'NaN', '1e3', '']) assert.throws(() => notionalToYu(value, '1'));
});
test('book walks preserve negative and zero rates; choose correct side; never extrapolate missing depth', () => {
  const book = { long: { ia: [0, -100], sz: ['1000000000000000000', '1000000000000000000'] }, short: { ia: [100, 200], sz: ['1000000000000000000', '1000000000000000000'] } };
  assert.equal(walkBook(book, 'short', 10n ** 18n).apr, 0);
  assert.equal(walkBook(book, 'short', 2n * 10n ** 18n).apr, -.005);
  assert.equal(walkBook(book, 'long', 2n * 10n ** 18n).apr, .015);
  assert.equal(walkBook(book, 'long', 3n * 10n ** 18n).full, false);
  assert.equal(walkBook(null, 'short', 1n), null);
});
test('real-book pair quote follows side and freshness; incomplete depth cannot produce a full spread', async () => {
  const p = groups.flatMap(g => g.pairs).find(p => p.a.marketId === 220 && p.b.marketId === 222);
  const books = new Map();
  for (const id of [220, 222]) books.set(id, { data: await read(`book-${id}.snapshot.json`), mode: 'live' });
  const now = Math.max(...[...books.values()].map(b => b.data.syncStatus.timestamp));
  const q = estimatePair(p, books, '10000', 'short', now);
  assert.equal(q.full, true); assert.equal(q.actionA, 'short'); assert.equal(q.actionB, 'long');
  assert.ok(Math.abs(q.apr - (q.qa.apr - q.qb.apr)) < 1e-10);
  assert.ok(q.costUsd > 0);
  assert.equal(estimatePair(p, books, '10000', 'short', now + 121).fresh, false);
  assert.equal(estimatePair(p, books, '100000000', 'short', now).apr, null);
  books.delete(222); assert.equal(estimatePair(p, books, '10000', 'short', now).apr, null);
});
test('history joins timestamps, rejects missing values, and keeps genuine zero', () => {
  assert.deepEqual(alignedHistory({ results: [{ ts: 1, mr: 0 }, { ts: 2, mr: .1 }, { ts: 3, mr: null }] }, { results: [{ ts: 2, mr: .2 }, { ts: 1, mr: 0 }, { ts: 3, mr: .1 }] }), [{ ts: 1, value: 0 }, { ts: 2, value: -.1 }]);
});
test('CSV preserves negative numeric rates and neutralizes text formulas', () => {
  const result = csvText([['=HYPERLINK("bad")', -.05]]);
  assert.ok(result.includes("'=HYPERLINK")); assert.ok(result.includes('"-0.05"'));
});
