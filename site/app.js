import { groupMarkets, activeMarkets, isNumber, subtract, estimatePair, alignedHistory, historyStats, csvText, VENUES, YEAR } from './lib/core.js';
import { fetchOverview, fetchBook, fetchHistory, fetchUnderlying, cacheGet, cacheSet } from './lib/api.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (value, digits = 2) => isNumber(value) ? (value * 100).toFixed(digits) + '%' : '—';
const signed = (value, digits = 2) => isNumber(value) ? (value > 0 ? '+' : '') + (value * 100).toFixed(digits) + '%' : '—';
const money = value => isNumber(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) : '—';
const color = value => !isNumber(value) || Math.abs(value) < 1e-8 ? 'neutral' : value > 0 ? 'positive' : 'negative';
const time = (epoch, date = true) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: date ? '2-digit' : undefined, day: date ? '2-digit' : undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epoch * 1000));
const expiry = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);
const shortName = venue => venue === 'Hyperliquid' ? 'Hyperliquid' : venue;
const pairLabel = p => `${shortName(p.a.platform.name)} − ${shortName(p.b.platform.name)}`;
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const state = { view: 'spreads', asset: 'BTC', groupKey: '', overview: null, groups: [], selected: null,
  search: '', sort: 'bid', page: 0, days: 7, direction: 'short', amount: '10000',
  books: new Map(), history: new Map(), historyLoading: false, quoteLoading: false,
  favorite: new Set(Array.isArray(cacheGet('favorites')) ? cacheGet('favorites') : []),
  funding: new Map(), fundingLoaded: new Map(), fundingLoading: false, bootstrap: null, refreshing: false, error: '', detailSeq: 0,
};
const viewNames = { spreads: '全市场价差', native: '原生 / 合成对比', funding: '资金费率矩阵', favorites: '我的关注' };
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function currentGroup() { return state.groups.find(g => g.key === state.groupKey); }
function currentPair() { return currentGroup()?.pairs.find(p => p.id === state.selected) ?? null; }
function setHash() {
  const params = new URLSearchParams({ view: state.view, asset: state.asset });
  if (state.groupKey) params.set('group', state.groupKey);
  if (state.selected) params.set('pair', state.selected);
  history.replaceState(null, '', `#${params}`);
}
function chooseGroup(preferredKey = state.groupKey) {
  const groups = state.groups.filter(g => g.underlying === state.asset);
  const old = groups.find(g => g.key === preferredKey);
  const future = groups.filter(g => g.maturity > Date.now() / 1000 + 3 * 86400 && g.pairs.length);
  const group = old ?? future[0] ?? groups.find(g => g.pairs.length) ?? groups[0];
  state.groupKey = group?.key ?? '';
  const pairs = group?.pairs ?? [];
  if (!pairs.some(p => p.id === state.selected)) state.selected = pairs.find(p => p.native)?.id ?? pairs[0]?.id ?? null;
  state.page = 0;
}
function setOverview(overview) {
  state.overview = overview;
  state.groups = groupMarkets(overview.results, overview.assets);
  if (!state.groups.some(g => g.underlying === state.asset)) state.asset = state.groups[0]?.underlying ?? 'BTC';
  chooseGroup(); renderAll(); setHash();
}
function renderStatus() {
  const data = state.overview;
  if (!data) return;
  const blockTime = Math.min(...data.syncStatuses.map(s => s?.timestamp).filter(isNumber));
  const stale = !Number.isFinite(blockTime) || Date.now() / 1000 - blockTime > 120;
  const live = data.mode === 'live' && !stale;
  $('#feed-status').className = `feed-status ${live ? 'live' : 'cached'}`;
  $('#feed-status').innerHTML = `<i></i>${live ? '官方行情 · 60s 刷新' : '缓存快照 · 非实时'}`;
  $('#last-updated').textContent = `更新于 ${time(data.fetchedAt / 1000)} · 北京时间`;
  $('#refresh').classList.toggle('loading', state.refreshing);
  $('#refresh').disabled = state.refreshing;
  const message = state.error || (!live ? `当前显示 ${time(data.fetchedAt / 1000)} 的${data.mode === 'live' ? '接口数据，链上同步时间已超过 120 秒' : '缓存快照'}。请核对时间后使用，参考报价不保证成交。` : '');
  $('#notice').hidden = !message;
  $('#notice').textContent = message;
}
function renderMetrics() {
  const all = state.groups.flatMap(g => g.pairs);
  const singles = activeMarkets(state.overview.results).filter(m => !m.metadata.isSpreadMarket);
  const natives = activeMarkets(state.overview.results).filter(m => m.metadata.isSpreadMarket);
  const group = currentGroup();
  const rates = (group?.pairs ?? []).flatMap(p => [p.bid, isNumber(p.ask) ? -p.ask : null]).filter(isNumber);
  const max = rates.length ? Math.max(...rates) : null;
  $('#nav-count').textContent = all.length;
  const rows = [
    ['合成价差组合', 'PAIRS', String(all.length).padStart(2, '0'), `${singles.length} 个单腿市场 · ${all.length * 2} 个方向`],
    ['交易所覆盖', 'VENUES', String(new Set(singles.map(m => m.platform.platformId)).size).padStart(2, '0'), `${new Set(singles.map(m => m.metadata.underlyingSymbol)).size} 种底层标的 · 动态发现`],
    ['原生价差市场', 'NATIVE', String(natives.length).padStart(2, '0'), '独立订单簿 · 以净价差计提风险'],
    ['当前分组最大参考差', 'SPREAD', isNumber(max) ? `${(max * 100).toFixed(2)}<span class="unit">%</span>` : '—', '两种方向的顶档参考 · 未计费用'],
  ];
  $('#metrics').innerHTML = rows.map(([label, code, value, note]) => `<div class="metric"><span>${label}<small>${code}</small></span><strong>${value}</strong><p>${note}</p></div>`).join('');
}
function renderFilters() {
  const preferred = ['BTC', 'ETH', 'HYPE'];
  const symbols = [...new Set(state.groups.map(g => g.underlying))].sort((a, b) => (preferred.includes(a) ? preferred.indexOf(a) : 99) - (preferred.includes(b) ? preferred.indexOf(b) : 99) || a.localeCompare(b));
  $('#asset-tabs').innerHTML = symbols.map(asset => `<button data-asset="${esc(asset)}"${asset === state.asset ? ' class="active"' : ''} aria-pressed="${asset === state.asset}"><span class="coin ${preferred.includes(asset) ? asset.toLowerCase() : 'hype'}">${esc(({ BTC: '₿', ETH: 'Ξ', HYPE: 'H' })[asset] ?? asset.slice(0, 1))}</span>${esc(asset)}</button>`).join('');
  $$('#asset-tabs button').forEach(b => { b.classList.toggle('active', b.dataset.asset === state.asset); b.setAttribute('aria-pressed', String(b.dataset.asset === state.asset)); b.disabled = !state.groups.some(g => g.underlying === b.dataset.asset); });
  const groups = state.groups.filter(g => g.underlying === state.asset);
  const group = currentGroup();
  const dates = [...new Set(groups.map(g => g.maturity))].sort((a, b) => a - b);
  $('#expiry').innerHTML = dates.map(d => `<option value="${d}"${d === group?.maturity ? ' selected' : ''}>${expiry(d)}</option>`).join('') || '<option>暂无到期市场</option>';
  $('#collateral').innerHTML = groups.filter(g => g.maturity === group?.maturity).map(g => `<option value="${esc(g.key)}"${g.key === state.groupKey ? ' selected' : ''}>${esc(g.asset.symbol)}</option>`).join('') || '<option>—</option>';
}
function filteredPairs() {
  let rows = [...(currentGroup()?.pairs ?? [])];
  if (state.view === 'favorites') rows = rows.filter(p => state.favorite.has(p.id));
  const query = state.search.toLowerCase().trim();
  if (query) rows = rows.filter(p => pairLabel(p).toLowerCase().includes(query));
  rows.sort((a, b) => state.sort === 'name' ? pairLabel(a).localeCompare(pairLabel(b)) : (b[state.sort] ?? -Infinity) - (a[state.sort] ?? -Infinity));
  return rows;
}
function starButton(pair) { return `<button class="star-button ${state.favorite.has(pair.id) ? 'saved' : ''}" data-star="${pair.id}" aria-label="${state.favorite.has(pair.id) ? '取消关注' : '关注'} ${esc(pairLabel(pair))}" aria-pressed="${state.favorite.has(pair.id)}">${state.favorite.has(pair.id) ? '★' : '☆'}</button>`; }
function pairName(pair) { return `<div class="pair-name"><span>${esc(shortName(pair.a.platform.name))}</span><span class="minus">−</span><span>${esc(shortName(pair.b.platform.name))}</span></div><div class="pair-sub">${esc(pair.group.underlying)} · ${esc(pair.group.asset.symbol)}${pair.native ? '<span class="native-badge">有原生</span>' : ''}</div>`; }
function renderTable() {
  const rows = filteredPairs();
  const pages = Math.max(1, Math.ceil(rows.length / 6)); state.page = Math.min(state.page, pages - 1);
  const pageRows = rows.slice(state.page * 6, state.page * 6 + 6);
  $('#pair-count').textContent = rows.length;
  $('#table-title').childNodes[0].textContent = state.view === 'favorites' ? '我的关注 ' : '全部合成价差 ';
  $('#prev').disabled = state.page === 0; $('#next').disabled = state.page >= pages - 1;
  $('#page-number').textContent = `${state.page + 1} / ${pages}`;
  $('#table-summary').textContent = rows.length ? `显示 ${state.page * 6 + 1}–${Math.min(rows.length, state.page * 6 + 6)} / ${rows.length} 组 · 点击查看双腿` : '当前分组暂无匹配结果';
  if (!rows.length) {
    $('#spread-table').innerHTML = `<div class="empty-state"><span>${state.view === 'favorites' ? '这个分组还没有关注的价差' : '没有找到匹配的价差'}</span><p>${state.view === 'favorites' ? '点击组合旁的星标即可收藏，也可以切换到期日查看其他关注。' : '尝试切换标的、抵押品或到期日。只有匹配的双腿才会出现在这里。'}</p></div>`;
    return;
  }
  $('#spread-table').innerHTML = `<table class="spread-table"><thead><tr><th><span aria-hidden="true">☆</span></th><th>交易所组合 A − B</th><th>中间价差</th><th>做空参考差</th><th>做多参考差</th><th>两腿底层差¹</th><th></th></tr></thead><tbody>${pageRows.map(p => `<tr data-pair="${p.id}" class="${p.id === state.selected ? 'selected' : ''}"><td>${starButton(p)}</td><td>${pairName(p)}</td><td class="${color(p.mid)}">${signed(p.mid)}</td><td class="${color(p.bid)}">${signed(p.bid)}</td><td class="${color(p.ask)}">${signed(p.ask)}</td><td class="muted">${signed(p.floatingReference)}</td><td><button class="select-pair" data-pair="${p.id}" aria-label="查看 ${esc(pairLabel(p))} 双腿详情">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>${pageRows.map(p => `<article class="mobile-pair ${p.id === state.selected ? 'selected' : ''}" data-pair="${p.id}"><div class="mobile-pair-top"><button data-pair="${p.id}" aria-label="查看 ${esc(pairLabel(p))} 双腿详情">${pairName(p)}</button>${starButton(p)}</div><div class="mobile-pair-rates"><div><span>中间价差</span><strong class="${color(p.mid)}">${signed(p.mid)}</strong></div><div><span>做空参考差</span><strong class="${color(p.bid)}">${signed(p.bid)}</strong></div><div><span>做多参考差</span><strong class="${color(p.ask)}">${signed(p.ask)}</strong></div></div></article>`).join('')}<p class="chart-caption">¹ 各腿当前底层 APR 的观察差，结算周期可能不同；不等同于同一窗口的实际结算差。</p>`;
}
function selectedSeries() {
  const pair = currentPair();
  if (!pair) return [];
  const a = state.history.get(`${pair.a.marketId}:${state.days}`), b = state.history.get(`${pair.b.marketId}:${state.days}`);
  return alignedHistory(a?.data, b?.data).filter(r => r.ts >= Date.now() / 1000 - state.days * 86400);
}
function renderChart() {
  const pair = currentPair();
  $('#chart-title').textContent = pair ? pairLabel(pair) : '暂无可匹配组合';
  $('#chart-current').textContent = pair ? signed(subtract(pair.a.data.markApr, pair.b.data.markApr)) : '—';
  $('#chart-current').className = pair ? color(subtract(pair.a.data.markApr, pair.b.data.markApr)) : '';
  const series = selectedSeries();
  $('.chart-panel .chart-caption')?.remove();
  if (series.length < 2) {
    $('#history-chart').innerHTML = `<div class="chart-empty">${state.historyLoading ? '正在读取官方历史数据…' : '这个范围暂无足够的对齐历史数据'}</div>`;
    $('#chart-stats').innerHTML = ''; return;
  }
  const stats = historyStats(series);
  const W = 640, H = 206, L = 7, R = 57, T = 14, B = 29;
  const minTs = series[0].ts, maxTs = series.at(-1).ts;
  const padding = Math.max((stats.max - stats.min) * .2, .0005);
  const lo = stats.min - padding, hi = stats.max + padding;
  const x = ts => L + (ts - minTs) / (maxTs - minTs) * (W - L - R);
  const y = value => T + (hi - value) / (hi - lo) * (H - T - B);
  const d = series.map((r, i) => `${i ? 'L' : 'M'}${x(r.ts).toFixed(2)},${y(r.value).toFixed(2)}`).join(' ');
  const area = `${d} L${x(maxTs)},${H - B} L${L},${H - B} Z`;
  const lines = Array.from({ length: 4 }, (_, i) => { const value = lo + (hi - lo) * i / 3; return `<line x1="${L}" x2="${W - R}" y1="${y(value)}" y2="${y(value)}" stroke="#2a3d45" stroke-width=".7" stroke-dasharray="3 5"/><text x="${W - R + 11}" y="${y(value) + 3}" fill="#6c8997" font-family="Consolas,monospace" font-size="9">${fmt(value)}</text>`; }).join('');
  const labels = [0, .25, .5, .75, 1].map(v => { const ts = minTs + (maxTs - minTs) * v; return `<text x="${x(ts)}" y="${H - 5}" text-anchor="${v === 0 ? 'start' : v === 1 ? 'end' : 'middle'}" fill="#587887" font-family="Consolas,monospace" font-size="9">${state.days === 1 ? time(ts, false) : time(ts).slice(0, 5)}</text>`; }).join('');
  $('#history-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(pairLabel(pair))} 最近 ${state.days} 天的 Mark APR 差历史，共 ${series.length} 个对齐样本"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7ae6ac" stop-opacity=".18"/><stop offset="100%" stop-color="#7ae6ac" stop-opacity="0"/></linearGradient></defs>${lines}<path d="${area}" fill="url(#chart-fill)"/><path d="${d}" fill="none" stroke="#90e9ba" stroke-width="1.8" stroke-linejoin="round"/><circle cx="${x(maxTs)}" cy="${y(series.at(-1).value)}" r="3" fill="#abf2cb"/>${labels}</svg><div class="chart-tooltip" hidden></div>`;
  const first = series[0].ts, last = series.at(-1).ts;
  $('#chart-stats').innerHTML = `<div><span>窗口平均差</span><strong>${signed(stats.mean)}</strong></div><div><span>窗口最低 / 最高</span><strong>${fmt(stats.min)} / ${fmt(stats.max)}</strong></div><div><span>${series.length} 个样本 · ${state.days === 30 ? '日频' : '小时频'}</span><strong>${time(last)} 更新</strong></div>`;
  const historyA = state.history.get(`${pair.a.marketId}:${state.days}`);
  const historyB = state.history.get(`${pair.b.marketId}:${state.days}`);
  const caption = document.createElement('p'); caption.className = 'chart-caption';
  caption.textContent = `${historyA?.mode === 'live' && historyB?.mode === 'live' ? '官方历史' : '缓存历史'} · ${time(first)}—${time(last)} · 两腿按时间戳对齐；前向填充不表示新成交。`;
  $('.chart-panel').append(caption);
  const chart = $('#history-chart'), tooltip = chart.querySelector('.chart-tooltip');
  chart.onpointermove = event => {
    const rect = chart.getBoundingClientRect();
    const proportion = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * W - L) / (W - L - R)));
    const targetTs = minTs + proportion * (maxTs - minTs);
    const row = series.reduce((nearest, r) => Math.abs(r.ts - targetTs) < Math.abs(nearest.ts - targetTs) ? r : nearest, series[0]);
    tooltip.textContent = `${time(row.ts)}  ${signed(row.value, 3)}`; tooltip.hidden = false;
    tooltip.style.left = `${Math.max(5, Math.min(rect.width - 190, event.clientX - rect.left))}px`;
  };
  chart.onpointerleave = () => tooltip.hidden = true;
}
function renderQuote() {
  const pair = currentPair();
  if (!pair) { $('#quote-content').innerHTML = '<div class="empty-state compact">当前分组没有可匹配的两条腿</div>'; $('#quote-state').textContent = '无组合'; return; }
  const quote = estimatePair(pair, state.books, state.amount, state.direction);
  if (quote.error) { $('#quote-content').innerHTML = `<div class="empty-state compact">${esc(quote.error)}</div>`; $('#quote-state').textContent = '检查金额'; return; }
  quote.fresh = quote.fresh && state.overview?.mode === 'live';
  $('#quote-state').textContent = state.quoteLoading ? '正在读取' : !quote.full ? '深度不足 / 缺失' : quote.fresh ? '实时盘口参考' : '缓存盘口';
  const leg = (m, q, action) => `<div class="quote-leg"><span class="${action}">${action === 'short' ? 'SHORT · 收固定' : 'LONG · 付固定'}</span><strong>${esc(m.platform.name)}</strong><small>${q?.full ? fmt(q.apr, 3) : q ? `覆盖 ${(q.fraction * 100).toFixed(1)}%` : '等待读取'}</small><em>#${m.marketId} · ${quote.yu.toFixed(4)} YU</em></div>`;
  const booksTime = [pair.a, pair.b].map(m => state.books.get(m.marketId)?.data.syncStatus?.timestamp).filter(isNumber);
  const stamp = booksTime.length === 2 ? `盘口 ${time(Math.min(...booksTime), false)} · 跨腿时差 ${quote.syncSkew}s` : '等待两腿完整盘口';
  $('#quote-content').innerHTML = `<div class="quote-legs">${leg(pair.a, quote.qa, quote.actionA)}${leg(pair.b, quote.qb, quote.actionB)}</div><div class="quote-result"><span>${state.direction === 'short' ? '收取的固定价差' : '支付的固定价差'}</span><strong class="${color(quote.apr)}">${quote.full ? signed(quote.apr) : '—'}</strong></div><div class="cost-lines"><div><span>双腿总名义金额</span><strong>${money(Number(state.amount) * 2)}</strong></div><div><span>距到期</span><strong>${(quote.years * 365).toFixed(1)} 天</strong></div><div><span>固定腿现金流情景¹</span><strong>${money(quote.fixedCashUsd)}</strong></div><div><span>开仓 + 持有期 Boros 费用²</span><strong>${money(quote.costUsd)}</strong></div></div><p class="quote-note">${esc(stamp)}<br><span class="${!quote.fresh || !quote.full ? 'warning-text' : ''}">${state.quoteLoading ? '正在刷新盘口。' : !quote.full ? '指定金额超出已知深度，或某一腿行情不可用。' : !quote.fresh ? '缓存或不同步盘口仅供回看，请刷新后核验。' : '分桶盘口估算，不保证两腿同时成交。'}</span><br>¹ 按当前秒数和固定差估算，尚未扣除浮动腿，不是利润。<br>² 不含 gas、首次进入市场费和外部永续成本${quote.amm ? '，当前组合另有 AMM 路由费用待核实' : ''}。</p><a class="quote-link" href="https://boros.pendle.finance/" target="_blank" rel="noopener noreferrer">前往 Boros · 手动核对两腿 ${icon('external')}</a>`;
}
async function loadDetails(force = false) {
  const pair = currentPair(); if (!pair) { renderChart(); renderQuote(); return; }
  const seq = ++state.detailSeq;
  state.historyLoading = true; state.quoteLoading = true; renderChart(); renderQuote();
  const days = state.days;
  const bookTask = Promise.allSettled([pair.a, pair.b, ...(pair.native ? [pair.native] : [])].map(async m => {
    const value = await fetchBook(m.marketId, force); state.books.set(m.marketId, value); return value;
  })).then(results => {
    if (seq !== state.detailSeq) return;
    state.quoteLoading = false; renderQuote();
    if (results.some(r => r.status === 'rejected') && !state.books.has(pair.a.marketId)) toast('部分盘口暂不可用，已保留快照并标明时间');
  });
  const historyTask = Promise.allSettled([pair.a, pair.b].map(async m => {
    const value = await fetchHistory(m.marketId, days); state.history.set(`${m.marketId}:${days}`, value); return value;
  })).then(() => {
    if (seq !== state.detailSeq) return;
    state.historyLoading = false; renderChart();
  });
  await Promise.allSettled([bookTask, historyTask]);
}
function renderNative() {
  const pairs = state.groups.filter(g => g.underlying === state.asset && g.key === state.groupKey).flatMap(g => g.pairs).filter(p => p.native);
  $('#native-content').innerHTML = pairs.length ? pairs.map(p => {
    const n = p.native;
    const edgeA = subtract(n.data.bestBid, p.ask), edgeB = subtract(p.bid, n.data.bestAsk);
    return `<article class="native-card"><div class="native-title">${esc(p.group.underlying)} · Hyperliquid − Gate<small>${expiry(p.group.maturity)} 到期 · ${esc(p.group.asset.symbol)} 抵押 · 原生 #${n.marketId}</small></div><div class="comparison-rates"><h3>原生 Spread Market</h3><div><span class="positive">${fmt(n.data.bestBid)}</span><span class="muted">/</span><span>${fmt(n.data.bestAsk)}</span></div><small>卖价参考 / 买价参考</small></div><div class="comparison-rates"><h3>双腿合成</h3><div><span class="positive">${fmt(p.bid)}</span><span class="muted">/</span><span>${fmt(p.ask)}</span></div><small>bid A − ask B / ask A − bid B</small></div><div class="native-foot"><span>卖原生 / 买合成：<b class="${color(edgeA)}">${signed(edgeA)}</b>　卖合成 / 买原生：<b class="${color(edgeB)}">${signed(edgeB)}</b>　· 均未计费用与规模</span><button data-open-pair="${p.id}">查看双腿深度 →</button></div></article>`;
  }).join('') : '<div class="empty-state"><span>这个分组尚未挂牌原生价差</span><p>可通过「全市场价差」查看可匹配的 Boros 双腿组合，或切换到其他到期日。</p></div>';
}
async function loadFunding(force = false) {
  const asset = state.asset;
  if (Date.now() - (state.fundingLoaded.get(asset) ?? 0) < 300000 && !force) { renderFunding(); return; }
  state.fundingLoading = true; renderFunding();
  const queue = [...VENUES];
  const worker = async () => {
    while (queue.length) {
      const venue = queue.shift();
      try { const result = await fetchUnderlying(asset, venue); state.funding.set(`${asset}:${venue}`, result); }
      catch { if (!state.funding.has(`${asset}:${venue}`)) state.funding.set(`${asset}:${venue}`, { data: { results: [] }, mode: 'unavailable' }); }
      if (state.asset === asset && state.view === 'funding') renderFunding();
    }
  };
  await Promise.allSettled([worker(), worker(), worker()]);
  state.fundingLoaded.set(asset, Date.now()); state.fundingLoading = false;
  if (state.asset === asset) renderFunding();
}
function fundingRows() {
  return VENUES.map(venue => {
    const value = state.funding.get(`${state.asset}:${venue}`);
    const rows = [...(value?.data.results ?? [])].filter(r => isNumber(r.underlyingApr) && isNumber(r.periodStartTimestamp)).sort((a, b) => a.periodStartTimestamp - b.periodStartTimestamp);
    const last = rows.at(-1);
    const active = state.groups.some(g => g.underlying === state.asset && g.markets.some(m => m.platform.name.toLowerCase() === venue.toLowerCase()));
    let sum = 0, seconds = 0;
    for (let i = 0; i < rows.length - 1; i++) { const span = rows[i + 1].periodStartTimestamp - rows[i].periodStartTimestamp; if (span > 0 && span <= 28800) { sum += rows[i].underlyingApr * span; seconds += span; } }
    return { venue, value, active, last, average: seconds >= 3600 ? sum / seconds : null, span: seconds };
  });
}
function renderFunding() {
  $('#funding-asset').textContent = state.asset;
  $('#refresh-funding').disabled = state.fundingLoading;
  const rows = fundingRows();
  $('#funding-content').innerHTML = `<table class="funding-table"><thead><tr><th>交易所 / 覆盖</th><th>最近结算 APR</th><th>可用区间加权均值</th><th>样本时间（北京）</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.venue)}${!r.active ? '<span class="observation-badge">仅观察</span>' : ''}<small>${r.value?.mode === 'live' ? '官方费率数据集' : r.value?.mode === 'unavailable' ? '该标的暂无可用数据' : r.last ? '发布快照' : '正在读取'}</small></td><td class="${color(r.last?.underlyingApr)}">${signed(r.last?.underlyingApr, 3)}</td><td>${signed(r.average, 3)}<small>${r.span ? (r.span / 3600).toFixed(0) + 'h 可用覆盖' : '—'}</small></td><td>${r.last ? time(r.last.periodStartTimestamp) : '—'}<small>${r.last && Date.now() / 1000 - r.last.periodStartTimestamp > 9 * 3600 ? '时间较旧，避免直接比较' : '按各交易所原始周期'}</small></td></tr>`).join('')}</tbody></table>`;
  const available = rows.filter(r => r.last);
  if (available.length < 2) { $('#heatmap').innerHTML = `<div class="empty-state">${state.fundingLoading ? '正在读取并归一化资金费率…' : '至少需要两家交易所的可用数据'}</div>`; return; }
  $('#heatmap').innerHTML = `<div class="heatmap-wrap"><table class="heatmap"><thead><tr><th>APR 差</th>${available.map(r => `<th>${esc(r.venue === 'Hyperliquid' ? 'HL' : r.venue)}</th>`).join('')}</tr></thead><tbody>${available.map(a => `<tr><th>${esc(a.venue)}</th>${available.map(b => {
    const delta = a.last.underlyingApr - b.last.underlyingApr;
    const level = Math.min(5, Math.max(1, Math.ceil(Math.abs(delta) * 30)));
    return `<td class="${a === b ? '' : `heat-${delta > 0 ? 'pos' : 'neg'}-${level}`}" title="${esc(a.venue)} ${time(a.last.periodStartTimestamp)} 减 ${esc(b.venue)} ${time(b.last.periodStartTimestamp)}">${a === b ? '—' : signed(delta, 2)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div><p class="heatmap-caption">这是最近已结算样本的观察矩阵，时间并不完全同步；预测费率、价差成交报价与实际到期收益均不同。手机可横向查看矩阵。</p>`;
}
function renderView() {
  const isMain = ['spreads', 'favorites'].includes(state.view);
  $('#spreads-view').hidden = !isMain; $('#native-view').hidden = state.view !== 'native'; $('#funding-view').hidden = state.view !== 'funding';
  $('#breadcrumb').textContent = viewNames[state.view];
  $$('.nav-item').forEach(b => { b.classList.toggle('active', b.dataset.view === state.view); b.setAttribute('aria-current', b.dataset.view === state.view ? 'page' : 'false'); });
  const titles = { spreads: ['跨交易所，', '发现价差。', '连接 Boros 单腿市场，让每一种费率差都有迹可循。'], native: ['同一价差，', '不同路径。', '原生订单簿与双腿合成并列，比较真实的买卖方向。'], funding: ['资金费率，', '横向看清。', '从各交易所已结算数据，观察同一标的的利率分歧。'], favorites: ['值得关注，', '留在这里。', '收藏你关心的组合。所有关注仅保存在当前浏览器。'] };
  const title = titles[state.view]; $('#page-title').innerHTML = `${title[0]}<span>${title[1]}</span>`; $('#page-subtitle').textContent = title[2];
  $('#group-controls')?.toggleAttribute('hidden', state.view === 'funding');
  $('.group-controls').hidden = state.view === 'funding';
}
function renderAll() {
  renderView(); renderStatus(); renderFilters(); renderMetrics(); renderTable(); renderChart(); renderQuote(); renderNative();
  if (state.view === 'funding') renderFunding();
}
async function refresh(force = false) {
  if (state.refreshing) return;
  state.refreshing = true; renderStatus();
  try {
    const result = await fetchOverview(force); state.error = ''; setOverview(result);
    if (['spreads', 'favorites'].includes(state.view)) await loadDetails(force);
  } catch (error) {
    state.error = `实时行情暂不可用：${error.message}。${state.overview ? '正在保留带原始时间的缓存快照。' : '请稍后重试。'}`;
    if (state.overview) setOverview({ ...state.overview, mode: 'cache' });
  } finally { state.refreshing = false; renderStatus(); }
}
function selectPair(id, scroll = false) {
  if (!currentGroup()?.pairs.some(p => p.id === id)) return;
  state.selected = id; renderTable(); renderChart(); renderQuote(); setHash(); loadDetails();
  if (scroll && matchMedia('(max-width:740px)').matches) $('#detail-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function switchView(view) {
  state.view = view; state.page = 0; renderAll(); setHash();
  if (view === 'funding') loadFunding();
}
document.addEventListener('click', event => {
  const star = event.target.closest('[data-star]');
  if (star) {
    const id = star.dataset.star;
    state.favorite.has(id) ? state.favorite.delete(id) : state.favorite.add(id);
    cacheSet('favorites', [...state.favorite]); renderTable(); return;
  }
  const pair = event.target.closest('[data-pair]'); if (pair) { selectPair(pair.dataset.pair, true); return; }
  const nativePair = event.target.closest('[data-open-pair]'); if (nativePair) { switchView('spreads'); selectPair(nativePair.dataset.openPair, true); return; }
  const nav = event.target.closest('[data-view]'); if (nav) { switchView(nav.dataset.view); return; }
  const asset = event.target.closest('[data-asset]'); if (asset) {
    state.asset = asset.dataset.asset; chooseGroup(); renderAll(); setHash();
    state.view === 'funding' ? loadFunding() : loadDetails(); return;
  }
  const range = event.target.closest('[data-days]'); if (range) {
    state.days = Number(range.dataset.days); $$('.range-tabs button').forEach(b => b.classList.toggle('active', b === range)); loadDetails(); return;
  }
  const direction = event.target.closest('[data-direction]'); if (direction) {
    state.direction = direction.dataset.direction; $$('.direction-tabs button').forEach(b => { b.classList.toggle('active', b === direction); b.setAttribute('aria-pressed', String(b === direction)); }); renderQuote(); return;
  }
  const amount = event.target.closest('[data-amount]'); if (amount) { $('#notional').value = amount.dataset.amount; updateAmount(); return; }
  if (event.target.closest('[data-action="method"]')) $('#method-dialog').showModal();
});
function updateAmount() {
  state.amount = $('#notional').value;
  $$('.amount-presets button').forEach(b => b.classList.toggle('active', b.dataset.amount === state.amount)); renderQuote();
}
$('#notional').addEventListener('input', updateAmount);
$('#search').addEventListener('input', event => { state.search = event.target.value; state.page = 0; renderTable(); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 0; renderTable(); });
$('#expiry').addEventListener('change', event => { const next = state.groups.find(g => g.underlying === state.asset && g.maturity === Number(event.target.value) && g.tokenId === currentGroup()?.tokenId) ?? state.groups.find(g => g.underlying === state.asset && g.maturity === Number(event.target.value)); chooseGroup(next?.key); renderAll(); setHash(); loadDetails(); });
$('#collateral').addEventListener('change', event => { chooseGroup(event.target.value); renderAll(); setHash(); loadDetails(); });
$('#prev').addEventListener('click', () => { state.page--; renderTable(); }); $('#next').addEventListener('click', () => { state.page++; renderTable(); });
$('#refresh').addEventListener('click', () => refresh(true)); $('#refresh-funding').addEventListener('click', () => loadFunding(true));
$('#close-dialog').addEventListener('click', () => $('#method-dialog').close());
$('#method-dialog').addEventListener('click', event => { if (event.target === $('#method-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#export').addEventListener('click', () => {
  const rows = [['标的', '到期日UTC', '抵押品', '交易所A', '交易所B', '中间价差APR(decimal)', '做空参考APR(decimal)', '做多参考APR(decimal)', '底层观察差(decimal)', '数据时间UTC', '数据模式', '报价口径'],
    ...filteredPairs().map(p => [state.asset, new Date(p.group.maturity * 1000).toISOString(), p.group.asset.symbol, p.a.platform.name, p.b.platform.name, p.mid, p.bid, p.ask, p.floatingReference, new Date(state.overview.fetchedAt).toISOString(), state.overview.mode, '顶档参考，未核验规模及费用'])];
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `boros-spreads-${state.asset}-${expiry(currentGroup()?.maturity ?? 0)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出当前筛选结果，包含时间与报价口径');
});
async function start() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (viewNames[params.get('view')]) state.view = params.get('view');
  if (/^[A-Z0-9&_.-]{1,24}$/.test(params.get('asset') ?? '')) state.asset = params.get('asset');
  state.groupKey = params.get('group') ?? ''; state.selected = params.get('pair');
  try {
    const result = await fetch(new URL('./data/bootstrap.json', import.meta.url), { signal: AbortSignal.timeout(8000) });
    if (!result.ok) throw new Error('发布快照暂不可用');
    const bundle = await result.json(); state.bootstrap = bundle;
    for (const [id, value] of Object.entries(bundle.books ?? {})) state.books.set(Number(id), { ...value, mode: 'snapshot' });
    for (const [key, value] of Object.entries(bundle.histories ?? {})) state.history.set(key, { ...value, mode: 'snapshot' });
    for (const [key, value] of Object.entries(bundle.funding ?? {})) state.funding.set(key, { ...value, mode: 'snapshot' });
    const cached = cacheGet('overview');
    const overview = cached?.fetchedAt > bundle.overview.fetchedAt && Array.isArray(cached.assets) && Array.isArray(cached.results) ? { ...cached, mode: 'cache' } : { ...bundle.overview, mode: 'snapshot' };
    setOverview(overview);
  } catch (error) {
    const cached = cacheGet('overview'); if (cached?.results && cached?.assets) setOverview({ ...cached, mode: 'cache' });
    else { $('#notice').hidden = false; $('#notice').textContent = `${error.message}，正在尝试官方接口。`; }
  }
  await refresh();
  if (state.view === 'funding') loadFunding();
  setInterval(() => {
    if (!document.hidden) { refresh(); if (state.view === 'funding') loadFunding(); }
  }, 60000);
  setInterval(() => { if (!document.hidden && state.overview) { renderStatus(); renderQuote(); } }, 15000);
}
start();
