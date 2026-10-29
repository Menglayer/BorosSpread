# Boros 价差看板：研究与实测

研究日期：2026-10-29，Asia/Shanghai。范围：Boros 双腿价差为主，同时观察交易所实际资金费率。本文完成研究和数据可行性验证，尚未实现看板。

## 1. 研究结论

可以做一个覆盖 Boros 全部匹配市场的价差看板。原生价差市场的数量，并不限制我们组合两个单腿市场进行比较。

但需要区分三层数据：

1. 原生价差：Boros 已挂牌、拥有独立订单簿的 Spread Market。
2. 双腿合成价差：两个 Funding Market 的组合，由两张订单簿分别报价、成交和计提风险。
3. 外部费率差：交易所的实际或预测资金费率之差。没有对应 Boros 市场时，只能观察，不能称为可在 Boros 交易的组合。

官方也支持用两个 Funding Market 构造价差，其匹配前提包含抵押品和到期日。[市场分类](https://docs.pendle.finance/boros-docs/about-boros/market-types)、[原生价差](https://docs.pendle.finance/boros-docs/about-boros/spread-markets)

## 2. 当前覆盖：已经调用真实 API

市场快照于北京时间 2026-10-29 10:15:50 左右完成，分三页取得。后续深度、指标及交易所抽测时间分别记录在各快照或 metadata 文件内，因此它们不是同一时刻的原子报价。

| 项目 | 快照结果 |
| --- | --- |
| 已取得的历史及当前市场 | 242 |
| 未到期且 UI 展示的市场 | 49 |
| 正常状态的单腿 Funding Market | 45 |
| 正常状态的原生 Spread Market | 4 |
| 单腿市场涉及的交易所 | 7 |
| 严格匹配的无方向双腿组合 | 94 |
| 每组展开为做多、做空后的方向数 | 188 |

这 94 组只是结构上匹配的候选组合，尚未逐组核验深度、费后收益、同步程度和账户约束。不能把 94 写成“94 个套利机会”。

| 标的 | 抵押品 | 到期日（北京时间 08:00） | 交易所 | 每期组合数 |
| --- | --- | --- | --- | --- |
| BTC | WBTC，tokenId=1 | 10-30、11-27、12-25 | Hyperliquid、Binance、Gate、OKX、KuCoin、Lighter | 15，共 45 |
| ETH | WETH，tokenId=2 | 10-30、11-27、12-25 | Hyperliquid、Binance、Gate、OKX、KuCoin、Lighter | 15，共 45 |
| HYPE | USD₮0，tokenId=3 | 10-30 | Hyperliquid、Gate、Bybit | 3 |
| HYPE | USD₮0，tokenId=3 | 11-27 | Hyperliquid、Bybit | 1 |

组合数量为每组交易所数量的 n×(n−1)/2。BTC 的另三个 USD₮0 抵押市场只有 Hyperliquid，BRENTOIL 也只有一个市场，不能凭空补齐第二条 Boros 腿。

四个原生价差都是 HL−Gate：ETH 11-27（232）、BTC 11-27（233）、ETH 12-25（242）、BTC 12-25（243）。当前快照没有其他原生交易所组合。

证据：[市场 API](https://api-boros.pendle.finance/apis/v1/markets?isMatured=false&isUiWhitelisted=true&limit=200)、本项目 `research/boros-markets.snapshot.json`、`research/coverage-analysis.json`。数字是研究时点的快照，生产系统必须动态发现。

## 3. Boros 究竟交易什么

Boros 是部署在 Arbitrum 的利率互换系统。订单簿和可选 AMM 交易的是未来到期前的一段利率现金流，不是 BTC、ETH 现货本金。[开发文档](https://docs.pendle.finance/boros-dev)、[Lite Paper](https://docs.pendle.finance/boros-dev/LitePaper)

- Underlying APR：外部交易所资金费率的年化值，或原生价差的底层差值。
- Implied APR：Boros 市场对这段利率现金流给出的交易价格。
- Fixed APR：实际成交后，仓位锁定的支付或收取利率。
- Mark APR：估值、保证金和清算参考利率，不保证能按此价格成交。
- Mid APR：中间参考价格，也不保证成交。

Long YU 支付固定、收取浮动；Short YU 收取固定、支付浮动。利率上涨通常有利于 long 的估值，下跌通常有利于 short。[仓位与利率](https://docs.pendle.finance/boros-docs/about-boros/implied-apr-and-position-sizing)、[订单簿](https://docs.pendle.finance/boros-docs/boros-systems/orderbook)

YU 的名义单位与市场抵押资产相关。BTC/WBTC 区域的 1 YU 对应 1 BTC 的利率名义敞口；USD₮0 抵押的 HYPE 市场，1 YU 按抵押资产单位计量，不能当作 1 HYPE。订单簿的 size 统一使用 18 位会计精度，不能用 ERC-20 的 8 位或 6 位精度去解码它。实际存取款的 token decimals 又是另一层单位。

## 4. 双腿价差的方向和收益

固定定义一个组合为 A−B，不随两条腿的高低自动改名。负价差是真实数值，不能取绝对值或归零。

设同一名义规模为 N，A、B 的浮动利率为 fA、fB，成交固定利率为 kA、kB。以下为忽略费用、采用共同计息区间的经济解释。

| 方向 | Boros 两条腿 | 固定与浮动净现金流 |
| --- | --- | --- |
| 做多 A−B | Long A，Short B | N×[(fA−fB)−(kA−kB)]×Δt |
| 做空 A−B | Short A，Long B | N×[(kA−kB)−(fA−fB)]×Δt |

Δt 用年表示。不同结算周期必须先按实际覆盖区间积分，再比较总现金流，不能把两个当前显示值视为同一历史结算期。

**只开 Boros 双腿仍然持有浮动价差敞口。** 例如收取 4% 固定价差，最终浮动价差平均 7%，仅看结算部分就会支付约 3% 年化差额，而非固定赚取 4%。

要在理想匹配条件下把资金费率差转成固定收入，还需要外部两条永续腿：Short A 永续、Long B 永续，收取 fA−fB，再用 Short A YU、Long B YU 支付该浮动差。这是四腿结构；有原生 Spread Market 时，Boros 两腿可替换成一条原生 short，成为三腿结构。[官方套利机制](https://docs.pendle.finance/boros-docs/arbitrage-with-crossex/overview)

实际结果还受成交价、基差、结算时点、抵押币价格、交易费、资金占用和清算影响。永续腿的价格敞口对冲，不代表抵押的 BTC、ETH 本身没有美元价格风险；币本位固定收益也不等于美元固定收益。界面里的“名义 APR”“保证金回报率”和“预计到期利润”必须分开。[成本与本金口径](https://docs.pendle.finance/boros-docs/arbitrage-with-crossex/position-pnl)

## 5. 真正该显示的价差价格

Boros 的 long 挂单是 bid，short 挂单是 ask。主动 short 吃 bid；主动 long 吃 ask。[开发者订单簿机制](https://docs.pendle.finance/boros-dev/Mechanics/OrderBook)

因此，A−B 的盘口参考区间为：

```text
中间价差参考       = midA − midB
做空价差可参考收取 = bidA − askB   （Short A / Long B）
做多价差可参考支付 = askA − bidB   （Long A / Short B）
```

指定规模后，必须分别沿两条腿的相应盘口计算 VWAP，再相减；深度不足就显示不足，不能外推最后一档，更不能用 mark 补成可成交价。AMM 存在时需核对实际路由和费用。

以研究快照里的 BTC 2026-11-27 HL−Binance 为例：

- 中间价差约 2.2885 个百分点。
- Short HL 的 bid 约 8.2094%；Long Binance 的 ask 约 6.1516%。
- 因此做空价差的顶档参考约 2.0578 个百分点，已经小于中间价差。
- 这还没计指定规模滑点和手续费，也不是两腿成交保证。

所有百分比使用 decimal fraction 保存：0.05=5%；0.01 的利率差=1 个百分点=100bp。不要把“两个 APR 相减”误写成相对增长百分比。

## 6. 原生价差与合成价差的比较

同一标的、同一抵押品和同一到期日下，可以把原生价差订单簿与两腿合成订单簿并列展示。

```text
卖原生、买合成的毛边际 = nativeBid − (askA − bidB)
卖合成、买原生的毛边际 = (bidA − askB) − nativeAsk
```

这些只是筛选参考。必须继续扣除三条 Boros 仓位的相应费用，验证名义规模、深度、oracle 定义、首尾计息区间及可成交性。只有中间价偏离，不能称为无风险套利。

原生市场按净价差本身计提风险；合成组合保留两条市场风险。Cross margin 可以共享同一抵押区域的权益，但不能自行假设两个单腿的保证金自动变成只针对净价差的一笔保证金。[保证金](https://docs.pendle.finance/boros-docs/boros-systems/margin-and-liquidations)

研究快照中 BTC 11-27：合成 bid 约 2.8509%、合成 ask 约 3.1636%，原生 bid 约 3.0557%、ask 约 3.1175%。两个交叉方向的顶档毛边际均为负，尽管两者中间价存在差别。其余组合和指定规模仍需独立检查。

## 7. 结算与现金账的细节

原生 HL−Gate 价差采用较慢腿的结算周期，快腿在相应窗口内取平均。官方底层资金费率来自独立 oracle，而不是 Boros 自己的订单簿。[费率结算](https://docs.pendle.finance/boros-docs/about-boros/rate-settlement)

我们额外调用了 220（HL BTC）、222（Gate BTC）、233（原生 BTC Spread）的约 48 小时结算数据，在 5 个完整的八小时窗口复算：

```text
八个 HL 小时结算 APR 的平均值 − 同一结算边界 Gate APR
  = 原生价差结算 APR
```

五个窗口残差绝对值均小于 1e-10，包含一个真实 0% 价差窗口。代码和原始数据保存在项目内。这不是全历史回测。

时间戳有一个必须保留的核对项：当前 schema 的 `periodTimestamp` 文字把它描述成 period start，但样本复算采用 `(t−8h, t]` 的 HL 结算打印对齐，和原生实际值匹配。生产数据适配器需要明确区分“交易所费率覆盖区间”“oracle 边界”“链上事件时间”和“API 标签”，不能仅凭字段名平移八小时。

此外，用户文档的“固定与浮动净额”是经济解释；合约会在交易时计入固定腿 upfront cost，再按累计 floating index 更新浮动腿，并采用 lazy settlement。链上 cash 不能简单当作 UI 的净入金。[合约结算与 lazy settlement](https://docs.pendle.finance/boros-dev/Mechanics/Settlement)

该机制也解释了 API 的 `data.timeToMaturity` 可能按最近资金结算边界计算，而不是严格等于 `maturity−当前秒数`。到期倒计时应使用市场实际 maturity；精确成交成本和账户健康度应跟随合约/模拟接口。

## 8. 费用与风险怎么进入看板

费用需要读取每个市场配置，不能使用全站固定常数：

- 订单簿 taker：规模×takerFee×剩余计息年数。
- 持仓结算费：规模×settleFeeRate×持有区间年数，两侧都可能收取。
- 首次进入市场费、gas，以及用户实际存在的折扣。
- 外部永续开仓、平仓费用与基差/价格冲击。

当前示例的单腿 takerFee 是 0.05% 年化参数，settleFeeRate 是 0.10%；原生 BTC Spread 分别是 0.10% 和 0.20%。这些是成本参数，不是收取本金同等百分比的一次性费用。原生与双腿的总费率在这个样本中相同，不能统一宣称原生费用必然更低。[费用机制](https://docs.pendle.finance/boros-docs/boros-systems/fees)

AMM 还存在自身费用与协议 OTC fee，必须遵循实际路由报价；不能只读取 `config.takerFee` 后就宣布含 AMM 的报价已算清所有成本。[AMM 机制](https://docs.pendle.finance/boros-dev/Mechanics/AMM)

风险面板至少需要：两腿保证金估算、利率敏感度、清算/账户健康度的可用状态、OI 上限、市场状态、结算时差和数据时效。估算保证金不等于建议投入的安全资金；清算价也不能用固定“杠杆倍数”反推。[开发者保证金](https://docs.pendle.finance/boros-dev/Mechanics/Margin)、[保护机制](https://docs.pendle.finance/boros-docs/boros-systems/protective-mechanism)

## 9. 接口、单位与数据质量

当前实测 API 根路径为 `https://api-boros.pendle.finance/apis`，schema 版本 `20261028.0824-45b0191`。公开仓库记录在 `research/schema-version.json`；完整下载文档和 schema 副本仅保留本地。

| 用途 | 已核实的新路径 |
| --- | --- |
| 资产与抵押币 | GET /v1/assets |
| 市场发现与配置 | GET /v1/markets |
| 按 ID 批量更新 | GET /v1/markets/by-ids |
| 订单簿 | GET /v1/markets/order-book |
| 历史费率，按标的/交易所查询 | GET /v1/markets/historical-underlying-apr |
| 历史指标 | GET /v1/indicators |
| 注册的费率源 | GET /v1/funding-rate/all-funding-rate-symbols |
| 实际链上结算记录 | POST /v1/funding-rate/settlement-summary |

部分说明页面仍展示 `/assets/all`、`/v2/markets/order-books` 等旧名称。后续以[实时 schema](https://api-boros.pendle.finance/apis/docs)和实测为准，不能照搬旧页面路径。

几个实测与设计约束：

- `/markets` 默认包含到期市场，必须处理 `resumeToken`，直到 null。直接取第一页会漏掉全部最新市场。
- 当前 status 枚举：0=PAUSED、1=CLOSE_ONLY、2=GOOD、3=ALO。不可把所有未到期市场当作可新开仓。
- metadata.isSpreadMarket 区分原生价差，不能只靠名称或平台数猜测。
- API 聚合盘口 `ia` 是按请求 tickSize 分桶的整数，APR=ia×tickSize；它不等于合约的指数映射 raw tick。
- 盘口 `sz` 是 18 位 bigint 字符串。保存和累计用 BigInt/高精度数；近似 VWAP 展示要明确其精度与来源。
- 缺失值用 null；真实 0、负利率均有效。不要用 `value || fallback`。
- 指标 `u` 的预测尾部会修订。`metadata.uLastSettledTimestamp` 用来区分已结算部分与实时尾部。
- 指标按网格 forward-fill，并不意味着每个网格都产生了一次新资金费率或新成交。
- 同一次组合计算需要携带两腿的 syncStatus，记录各自 block、timestamp、抓取时间和跨腿时间差。历史序列按时间区间对齐，不能按数组下标相减。

[指标机制](https://docs.pendle.finance/boros-dev/Backend/indicators)、[历史数据下载](https://docs.pendle.finance/boros-dev/Backend/historical-data)

实时层可使用官方 Socket.IO。market-data 推送价格字段，orderbook 或 orderbook-include-amm 推送聚合深度。断线应重取快照、重新订阅并标示过期；本轮只阅读了协议，尚未实测 WebSocket 长连接稳定性。[WebSocket](https://docs.pendle.finance/boros-dev/Backend/websocket)

免费 REST 限额按 IP 同时约束每分钟 200 CU 和每周 400,000 CU。单次市场列表及订单簿各约 2 CU，指标按选择数量计费。持续每 10 秒抓 45 张订单簿，理论每周约 544 万 CU，超过免费预算；不能用全量高频 REST 轮询实现看板。应共享服务端缓存、使用推送、按当前选中组合订阅深度并统计预算。[CU 限制](https://docs.pendle.finance/boros-dev/Backend/computing-units)

## 10. 外部交易所观察层

Boros 的费率源列表实测有 82 个条目，其中 2 个是 HL−Gate spread，其他源涉及 9 家交易所：Binance、Hyperliquid、Gate、OKX、KuCoin、Lighter、Bybit、Bitget、Deribit。注册费率源不等于已经挂牌 Boros 交易市场。

本轮直接调用七家有当前 Boros 单腿市场的交易所公开接口，均得到 HTTP 200 和对应行情响应；不需要用户密钥。另经 Boros 的历史 underlying 接口获取了 Bitget、Deribit 的 BTC 数据。注意这个接口的 exchange 参数在实测中区分名称形式：`Bitget`、`Deribit` 成功，小写版本返回 404。

| 数据源 | 抽测接口 / 单位注意点 |
| --- | --- |
| Hyperliquid | POST /info，metaAndAssetCtxs；BTC funding 样本 0.0000125，按 1h 解读为 10.95% APR |
| Binance | GET /fapi/v1/premiumIndex；结合 fundingInfo、合约元数据确定周期，不能把 lastFundingRate 当作稳定未来收益 |
| Gate | GET /api/v4/futures/usdt/contracts/BTC_USDT；funding_interval 为秒 |
| OKX | GET /api/v5/public/funding-rate；区分 fundingRate、settFundingRate、fundingTime 与 nextFundingTime |
| Bybit | GET /v5/market/tickers；样本包含 fundingIntervalHour，不能对所有合约固定 8h |
| KuCoin | GET /api/v1/funding-rate/XBTUSDTM/current；granularity 为毫秒，XBT 要映射 BTC |
| Lighter | GET /api/v1/funding-rates；包含其他交易所比较数据，必须按 exchange 过滤；该汇总接口的 rate 基准期仍需与实际 hourly funding 记录交叉确认 |

统一年化的前提是已明确原始费率覆盖的 h 小时：`APR = perPeriodRate × 24/h × 365`。实际结算和预测快照分别保存，历史平均按覆盖时长加权；缺失区间不能当 0 参与平均。

Lighter 官方确认每小时支付，但不能据此认定所有 API 的名为 rate 的字段都已经是每小时单位。未核清的单位不得进入机会排名。[Lighter 资金费率](https://docs.lighter.xyz/trading/funding)、[HL 资金费率](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)、[HL API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[Binance API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)、[Gate API](https://www.gate.com/docs/developers/apiv4/en/futures/)、[Bybit API](https://bybit-exchange.github.io/docs/v5/market/tickers)、[KuCoin 新版 API](https://www.kucoin.com/docs-new/v2/rest/ua/get-current-funding)

## 11. 官方现有工具值得参考的地方

Pendle 已发布 [arbitrage-with-crossex](https://github.com/pendle-finance/arbitrage-with-crossex)。本轮阅读其 main 对应 `93bdd318de2a08b68e56d81ce4e39ce47adcc8c6` 的分组、方向和机会估算源码，没有运行安装程序，也没有提交交易。

该工具已经按 collateral+maturity+underlying 分组，按卖 bid / 买 ask 计算指定规模，并分别计算名义收益率与资本回报率。我们的看板可参考这些机制，但应覆盖所有 Boros 合成组合，并同时展示原生与合成报价；观察范围不应依赖用户是否拥有 Gate CrossEx 账户。

源码参考：[分组与机会估算](https://github.com/pendle-finance/arbitrage-with-crossex/blob/93bdd318de2a08b68e56d81ce4e39ce47adcc8c6/src/core/boros/opportunities.ts)、[原生价差方向](https://github.com/pendle-finance/arbitrage-with-crossex/blob/93bdd318de2a08b68e56d81ce4e39ce47adcc8c6/src/core/boros/spread.ts)

## 12. 已验证和仍待验证

已完成：官方机制研究；实时 schema 保存；全量市场分页；抵押资产与费率源读取；四张盘口抽样；三组 500 点指标读取；七家交易所公开行情连通性抽测；Bitget/Deribit 历史源抽测；5 个完整原生价差结算窗口复算；离线生成 94 组候选组合。

尚未完成：看板 UI 和后台服务、全部组合的指定规模深度、全历史统计、WebSocket 稳定性、Lighter 汇总字段基准期、账户级保证金模拟、真实钱包或资金验证、部署。上述未验证部分不能包装成已上线功能或可执行交易承诺。

复算命令：`node scripts/analyze-boros-research.mjs`。命令只分析本地快照，不访问网络，不更新行情，不调用交易接口。
