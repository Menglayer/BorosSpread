# BorosSpread

以 Boros 双腿价差为主，并观察外部交易所实际资金费率的看板项目。

纯静态、无需交易密钥的 Boros 价差研究看板，可部署到 GitHub Pages。浏览器直接读取 Boros 官方公开 API；失败时回退到带原始时间的快照。当前未发布到远程仓库。

## 功能

- 动态发现同标的、同抵押品、同到期日的双腿组合；当前快照覆盖 94 组。
- 区分 mid、bid/ask 与指定美元规模的双腿盘口 VWAP 估算。
- 做多/做空方向、两腿动作、名义数量、固定腿现金流情景和 Boros 费用估算。
- 原生 Spread Market 与合成双腿的报价比较。
- 1 / 7 / 30 天 Mark APR 差历史；按时间戳对齐。
- 九家交易所的已结算资金费率观察和差值矩阵，数据来自 Boros 费率数据集。
- 搜索、排序、分页、本地收藏、CSV 导出、手机布局。
- 页面可见时每 60 秒刷新市场与选中盘口；历史与费率观察缓存 5 分钟。

## 本地运行

需要 Node.js 22 或更新版本，没有第三方依赖，无需 npm install。

```powershell
npm run dev
```

打开 `http://127.0.0.1:4173`。

```powershell
npm test
npm run snapshot
npm run build
```

`snapshot` 读取公开行情，更新 `site/data/bootstrap.json`；`build` 仅将允许的静态资源复制到 `dist/`。站点不发布研究原始文件、测试或开发脚本。

## GitHub Pages

已提供 `.github/workflows/pages.yml`，支持 main / master 推送及手动触发。仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。工作流先运行计算测试，尝试刷新快照，再构建并发布 `dist/`。临时行情接口故障不会阻断已存在快照的构建。

所有资源使用相对路径，适配 `https://<owner>.github.io/<repository>/`，无需填写仓库 base path。

本站内容和回退快照是公开市场数据。页面不支持交易，不接入钱包，不保存 API 密钥；GitHub Pages 发布的页面也不提供访问认证。参考报价与固定腿情景均不等于净利润或保证成交。

详见 [部署说明](docs/github-pages.md) 和 [验收记录](docs/validation.md)。

## 研究资料

- [Boros 研究与实测](docs/boros-research.md)
- [看板开发口径](docs/dashboard-spec.md)
- `research/`：公开 API 原始快照、schema 和候选组合分析

离线复算已有研究证据：

```powershell
node scripts/analyze-boros-research.mjs
```

该命令不刷新行情、不访问钱包、不提交交易。候选组合数量不代表可成交机会数量。
