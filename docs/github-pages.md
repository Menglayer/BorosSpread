# GitHub Pages 部署

当前方案为无依赖的纯静态站点。运行时不依赖 GitHub API、Actions、代理或服务器；浏览器直接读取 `https://api-boros.pendle.finance/apis` 的公开行情。已使用 Origin 请求头及实际浏览器验证跨域访问。

## 发布配置

1. 将项目推送到目标仓库的 main 或 master。
2. 仓库 Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
3. 执行 `Deploy BorosSpread to GitHub Pages` 工作流。
4. 工作流完成后，以 deploy 产出的 page_url 为实际访问地址，验证页面、静态资源和浏览器行情请求。

工作流权限：build 仅读取仓库，deploy 使用 `pages:write` 和 `id-token:write`。不需要交易密钥或额外仓库 Secrets。不配置定时任务；后续推送或手动触发工作流时更新发布快照。

构建只发布 `dist/` 下的 HTML/CSS/JS、图标和 `data/bootstrap.json`。研究目录、测试、文档截图和开发脚本不进入网页部署产物。发布源码的可见性由仓库可见性决定，和 Pages 的公开访问是两个概念。

## 行情与缓存

- 市场列表完整处理 resumeToken，过滤未到期、UI 展示、GOOD 状态。
- 每个浏览器标签页在可见时每 60 秒更新市场、抵押资产价格和当前组合盘口。
- 没有当前观测值的组合显示缺失，不用零或 mark 补成成交价。
- 历史/外部费率缓存五分钟；相同请求在标签页内合并。
- 接口 429 后暂停请求 60 秒，不激进重试。
- 失联后保留本地或发布快照，标明缓存与时间；不把快照伪装成实时。
- GitHub Pages 无法提供跨浏览器共享行情缓存。多用户流量增加后，应根据实际 CU 使用量增加共享数据服务；本版不会对全部盘口进行高频轮询。

## 本地查看最终产物

```powershell
npm test
npm run build
$env:PREVIEW_DIR = (Resolve-Path .\dist).Path
npm run dev
```

使用后可以删除 PREVIEW_DIR 环境变量：`Remove-Item Env:PREVIEW_DIR`。

## 发布验收

应同时核对 Actions 运行成功、Pages deployment 状态、公开 URL HTTP 200、JS/CSS 与当前产物匹配，并在浏览器确认实时行情或清楚标记的回退状态。仅有构建成功不能视为已上线。

GitHub 官方参考：[Pages 是静态托管](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[使用 Actions 部署 Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
