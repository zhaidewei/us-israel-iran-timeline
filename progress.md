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
- [x] `scripts/update.js` — GitHub Actions 完整数据更新脚本
- [x] `.github/workflows/update.yml` — 每小时定时任务
- [x] `vercel.json` — 函数超时 30s 配置
- [x] 前端 `public/app.js` — refresh 端点改为只读缓存，不再触发 LLM

### 部署
- [x] 代码已 push 到 GitHub main 分支
- [x] Vercel 项目已创建并部署（vercel link + vercel deploy --prod）
- [x] Upstash Redis（Frankfurt）通过 Vercel Marketplace 创建，KV 变量已自动注入 Vercel

### 环境变量
- [x] Vercel Production 已有：KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN, KV_URL, REDIS_URL, DEEPL_TOKEN
- [x] GitHub Secrets 已有：KV_REST_API_URL, KV_REST_API_TOKEN, DEEPL_TOKEN, DEEPSEEK_API_TOKEN

---

## 待完成（Todo）

### 1. 首次数据初始化（最优先）
GitHub Actions workflow 首次运行超时被取消，KV 里目前没有数据，网站是空的。

本地运行 scripts/update.js 直接写入 KV：

```bash
cd /Users/dewei_mac_mini/claude-workspace/us-israel-iran-timeline

# 加载 KV 凭证（来自 .env.vercel）
export $(grep -v '^#' .env.vercel | xargs)

# 设置 LLM/翻译 key
export DEEPL_TOKEN="YOUR_DEEPL_TOKEN"
export DEEPSEEK_API_TOKEN="YOUR_DEEPSEEK_TOKEN"

# 运行更新（约 2-3 分钟）
node scripts/update.js
```

运行成功后访问 https://us-israel-iran-timeline.vercel.app 应该能看到数据。

### 2. 验证网站功能
- [ ] 访问 https://us-israel-iran-timeline.vercel.app 确认数据正常显示
- [ ] /api/events、/api/analysis、/api/polymarket、/api/prices 返回正确 JSON

### 3. 连接 Vercel 与 GitHub（push 自动部署，可选）
目前是手动 vercel deploy --prod，连接后 push 即自动部署：
在 Vercel Dashboard → Project Settings → Git → Connect GitHub Repository

### 4. GitHub Actions 定时任务验证
- [ ] 等待下一个整点（UTC）确认 workflow 自动运行成功
- [ ] Actions 日志：https://github.com/zhaidewei/us-israel-iran-timeline/actions

---

## 关键信息

| 项目 | 值 |
|------|-----|
| Vercel 账号 | zhaidewei / dewei-zhais-projects |
| Upstash Redis | Frankfurt 区域，relieved-titmouse-23294.upstash.io |
| KV 凭证本地文件 | .env.vercel（已加入 .gitignore） |
| GitHub PAT | ghp_YOUR_PAT_HERE |

## Vercel CLI 常用命令

```bash
/opt/homebrew/bin/vercel env ls          # 查看环境变量
/opt/homebrew/bin/vercel deploy --prod --yes  # 重新部署
/opt/homebrew/bin/vercel logs https://us-israel-iran-timeline.vercel.app  # 查看日志
```

## GitHub Actions 手动触发

```bash
GH_TOKEN=ghp_YOUR_PAT_HERE \
  gh workflow run update.yml --repo zhaidewei/us-israel-iran-timeline
```
