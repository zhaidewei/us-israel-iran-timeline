# 美以伊战争时间线 — 项目进度

## 项目概述
本地 Web App，追踪美国/以色列 vs 伊朗冲突事件，全中文 UI，自动刷新。
访问地址：http://localhost:3000
启动命令：`node server.js`（在项目目录下）

---

## 技术栈
| 组件 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| RSS 解析 | rss-parser |
| 翻译 | DeepL API（`DEEPL_TOKEN` in ~/.zshrc） |
| LLM 分析 | DeepSeek API（`DEEPSEEK_API_TOKEN` in ~/.zshrc） |
| 前端 | 原生 HTML/CSS/JS，中文 UI |
| 图表 | Chart.js 4.4.0（CDN） |

---

## 文件结构
```
us-israel-iran-timeline/
├── server.js           # Express 后端，RSS/价格/Polymarket 抓取
├── package.json        # 依赖：express, rss-parser, node-fetch
├── events.json         # 新闻事件缓存（7天窗口）
├── polymarket.json     # Polymarket 预测市场缓存
├── prices.json         # 市场行情缓存（油价/美元/比特币）
├── progress.md         # 本文件
└── public/
    ├── index.html      # 主页面
    ├── style.css       # 深色主题样式
    └── app.js          # 前端逻辑
```

---

## API 端点
| 端点 | 说明 | 刷新频率 |
|---|---|---|
| `GET /api/events` | 返回缓存新闻事件 | — |
| `GET /api/refresh` | 拉取 RSS → 过滤 → 翻译 → LLM 分析 → 缓存 | 每10分钟自动 |
| `GET /api/reanalyze` | 对未分析事件补跑 DeepSeek | 手动 |
| `GET /api/polymarket` | 返回缓存预测市场 | — |
| `GET /api/polymarket/refresh` | 重新抓取 Polymarket | 每5分钟自动 |
| `GET /api/prices` | 返回缓存行情数据 | — |
| `GET /api/prices/refresh` | 重新抓取 Yahoo Finance | 每15分钟自动 |

---

## 已完成功能

### 1. 新闻时间线（RSS）
- **来源**：BBC中东、半岛电视台、以色列时报、卫报、耶路撒冷邮报、France 24、中东眼
- **双关键词过滤**：需同时匹配地理词（Israel/Iran/Gaza等）+ 动作词（missile/strike/war等）
- **7天时间窗口**：只保留最近7天事件
- **DeepL 翻译**：批量翻译标题，节省配额
- **DeepSeek LLM 分析**：每篇文章返回：
  - `eventCluster`：事件聚类 key（跨批次复用，同一事件归并）
  - `category`：军事打击 / 防空拦截 / 外交动向 / 人员伤亡 / 制裁经济 / 内政局势 / 其他
  - `importance`：1-5分（5=重大突发）
  - `briefZh`：30-50字中文战报摘要

### 2. 前端 Timeline UI
- **事件聚类**：同一 `eventCluster` 的文章合并显示，主卡展开"另有N个来源"
- **日期分组**：今天 / 昨天 / 具体日期 分隔线
- **分类筛选栏**：按类别或来源过滤，多选，"清除筛选"按钮
- **突发新闻横幅**：`importance=5` 事件显示红色动态横幅，可关闭
- **Toast 通知**：自动刷新有新事件时弹出提示
- **重要性标记**：⚡⚡（5分）、⚡（4分）脉冲动画
- **颜色编码**：BBC红 / 半岛橙 / 时报绿 / 卫报青

### 3. Polymarket 预测市场
- 使用 Gamma API（Events API + 市场宽泛抓取）
- 本地关键词过滤（`POLY_RELEVANT_KW`）确保相关性
- 显示 Yes/No 概率条 + 趋势箭头
- 每5分钟自动刷新
- **注意**：战争刚开始（2026-02-28），Polymarket 相关市场可能极少或暂无

### 4. 市场行情（价格走势图）
- **数据源**：Yahoo Finance v8 Chart API（query1/query2 自动故障转移）
- **资产**：
  - WTI原油 (`CL=F`)：橙色，单位 $/桶
  - 美元指数 (`DX-Y.NYB`)：蓝色，单位 DXY点
  - 比特币 (`BTC-USD`)：琥珀色，单位 $
- **图表**：Chart.js 折线图，渐变填充，无坐标轴的 Sparkline 样式，7天/1小时粒度
- **显示**：当前价格 + 涨跌幅（绿涨/红跌）+ 走势图
- 每15分钟自动刷新

---

## 已知问题 / 待改进

### Polymarket 无结果
- **原因**：Gamma API 的 `?search=` 参数不可靠，忽略查询词返回无关市场（体育、NBA等）
- **当前策略**：Events API（5个关键词搜索）+ 抓取300个市场（按volume/startDate）+ 本地关键词过滤
- **根本原因**：战争于今日（2026-02-28）爆发，Polymarket 相关市场若刚建立则成交量极低，排序靠后
- **建议**：手动在 polymarket.com 搜索并找到 conditionId，可硬编码到服务器

### Yahoo Finance 访问限制
- Yahoo Finance 有时会封锁请求（返回 401/429）
- 当前使用浏览器 User-Agent 绕过，但不稳定
- 若出现持续失败，可考虑换用 Alpha Vantage / Finnhub（需 API key）

---

## 环境变量（~/.zshrc）
```bash
export DEEPL_TOKEN="xxx:fx"          # DeepL 免费版（:fx 后缀）
export DEEPSEEK_API_TOKEN="sk-xxx"   # DeepSeek
```

---

## 版本历史（按实现顺序）
1. 初始版本：Express + RSS + MyMemory 翻译 + 基础时间线 UI
2. 升级：DeepL 翻译 + 双关键词过滤 + 7天窗口
3. 升级：DeepSeek LLM 分析（聚类/分类/重要性/briefZh）
4. 升级：跨批次事件聚类（clusterRef 复用已有 key）
5. 升级：6项前端改进（聚类展示/筛选栏/Toast/日期分组/突发横幅/LLM摘要替代机翻）
6. 升级：Polymarket 预测市场区块（概率条 + 趋势箭头）
7. 升级：市场行情区块（油价/美元/比特币 + Chart.js Sparkline）
8. RSS 来源调整：Reuters → AP News → 以色列时报（前两者 RSS 已停用）
9. 扩展 RSS 来源：新增耶路撒冷邮报、France 24 中东频道、中东眼，共 7 个来源；同步更新前端颜色图例（靛蓝/粉色/蓝绿）

---

_最后更新：2026-02-28（版本9）_
