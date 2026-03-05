# 项目进展 & Todo

## 项目地址
- **Vercel 网站**: https://us-israel-iran-timeline.vercel.app
- **GitHub 仓库**: https://github.com/zhaidewei/us-israel-iran-timeline
- **本地路径**: /Users/dewei_mac_mini/claude-workspace/us-israel-iran-timeline

---

## 已完成

### 架构改造（GitHub Actions + Vercel KV）
- [x] `lib/kv.js` — Upstash REST API 封装（兼容 KV_REST_API_URL 和 UPSTASH_REDIS_REST_URL）
- [x] `lib/translate.js` — DeepL 翻译
- [x] `lib/polymarket.js` — Polymarket 抓取
- [x] `lib/prices.js` — Yahoo Finance 抓取
- [x] `api/events/index.js` — GET /api/events（读 KV 缓存）
- [x] `api/analysis/index.js` — GET /api/analysis（读 KV 缓存）
- [x] `api/polymarket/index.js` — GET /api/polymarket（读 KV 缓存）
- [x] `api/polymarket/refresh.js` — GET /api/polymarket/refresh（实时抓，免费）
- [x] `api/prices/index.js` — GET /api/prices（读 KV 缓存）
- [x] `api/prices/refresh.js` — GET /api/prices/refresh（实时抓，免费）
- [x] `scripts/update.js` — 完整数据更新脚本（本地 + GitHub Actions 共用）
- [x] `.github/workflows/update.yml` — 每小时定时任务
- [x] `vercel.json` — 函数超时 30s 配置
- [x] 前端 `public/app.js` — refresh 端点改为只读缓存，不再触发 LLM

### Bug 修复
- [x] `lib/kv.js` set 函数双重序列化 bug — 原 `body: JSON.stringify([valueStr])` 改为 `body: valueStr` + `Content-Type: text/plain`，数据格式正确后已重新部署

### 部署
- [x] 代码已 push 到 GitHub main 分支
- [x] Vercel 项目已创建并部署（vercel link + vercel deploy --prod）
- [x] Upstash Redis（Frankfurt）通过 Vercel Marketplace 创建，KV 变量已自动注入 Vercel
- [x] KV 数据已初始化（本地运行 scripts/update.js 写入，81 条新闻）
- [x] 网站数据正常显示（events / analysis / polymarket / prices）

### 环境变量
- [x] Vercel Production 已有：KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN, KV_URL, REDIS_URL, DEEPL_TOKEN
- [x] GitHub Secrets 已有：KV_REST_API_URL, KV_REST_API_TOKEN, DEEPL_TOKEN, DEEPSEEK_API_TOKEN

### 本地定时任务（launchd）
- [x] plist 文件：`~/Library/LaunchAgents/com.dewei.iran-timeline-update.plist`
- [x] 每 3600 秒（1小时）自动运行 scripts/update.js
- [x] 日志：`~/Library/Logs/iran-timeline-update.log`
- [x] 错误日志：`~/Library/Logs/iran-timeline-update.error.log`
- [x] 已测试运行成功（约 48 秒完成，所有 API 正常）

---

## 待完成（Todo）

### 1. GitHub Actions 定时任务验证
- [ ] 等待下一个整点（UTC）确认 workflow 自动运行成功
- [ ] Actions 日志：https://github.com/zhaidewei/us-israel-iran-timeline/actions

### 2. 连接 Vercel 与 GitHub（push 自动部署，可选）
目前是手动 vercel deploy --prod，连接后 push 即自动部署：
在 Vercel Dashboard → Project Settings → Git → Connect GitHub Repository

---

## 关键信息

| 项目 | 值 |
|------|-----|
| Vercel 账号 | zhaidewei / dewei-zhais-projects |
| Upstash Redis | Frankfurt 区域，relieved-titmouse-23294.upstash.io |
| KV 凭证本地文件 | .env.vercel（已加入 .gitignore） |

## Vercel CLI 常用命令

```bash
/opt/homebrew/bin/vercel env ls                   # 查看环境变量
/opt/homebrew/bin/vercel deploy --prod --yes      # 重新部署
/opt/homebrew/bin/vercel logs https://us-israel-iran-timeline.vercel.app  # 查看日志
```

## 本地 launchd 定时任务

```bash
launchctl start com.dewei.iran-timeline-update    # 手动立刻触发
launchctl list | grep iran-timeline               # 查看状态
tail -f ~/Library/Logs/iran-timeline-update.log   # 查看日志
launchctl unload ~/Library/LaunchAgents/com.dewei.iran-timeline-update.plist  # 停用
```

## 本地手动运行更新

```bash
cd /Users/dewei_mac_mini/claude-workspace/us-israel-iran-timeline
export $(grep -v '^#' .env.vercel | xargs)
export DEEPL_TOKEN="your_token"
export DEEPSEEK_API_TOKEN="your_token"
node scripts/update.js
```
