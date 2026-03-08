# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start           # run local dev server on port 3000
npm test            # run all tests (Node built-in test runner, no install needed)
node --test test/polymarket-refresh.test.js   # run a single test file
```

Tests run automatically as a pre-commit hook.

## Environment Variables

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_TOKEN` | DeepSeek API key for translation + LLM event clustering / situation report |
| `REFRESH_API_KEY` / `CRON_SECRET` | Bearer token required by protected refresh endpoints |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (used in Vercel deployment only) |

## Architecture

This app has **two deployment targets** that share all `lib/` business logic:

### 1. Local / standalone Express server (`server.js`)
- Single-process Node server on port 3000
- Uses `lib/localStore.js` as the KV store (reads/writes `events.json`, `polymarket.json`, `prices.json`, `analysis.json` at the repo root)
- Schedules background refreshes with `setInterval` on startup
- `server.js` exports `{ app, _resetPolymarketCooldown }` for tests and guards `app.listen` behind `require.main === module`

### 2. Vercel serverless (`api/` directory)
- Each file under `api/` is a Vercel serverless function handler
- Uses `lib/kv.js` (Upstash Redis via REST) instead of `lib/localStore.js`
- Both stores expose the same `{ get, set }` interface, so all `lib/` functions accept either

### KV store abstraction
All `lib/` data-fetching functions take a `kv` argument (`{ get, set }`). This is what allows the same business logic to work with local JSON files or Upstash Redis. Never let `lib/` code `require` a store directly.

### Data flow per domain

**News** (`lib/news.js`): RSS feeds → DeepSeek LLM（翻译标题 + 聚类 + 分类 + briefZh，合并为一次调用）→ written to `kv.set('events', ...)`

**Polymarket** (`lib/polymarket.js`): Polymarket Gamma API (5 keyword searches + 3 broad fetches) → keyword filter (`POLY_RELEVANT_KW`) → DeepSeek translation of new questions only (scheduled tasks only) → written to `kv.set('polymarket', ...)`

**Prices** (`lib/prices.js`): Yahoo Finance v8 API (parallel, with fallback from query1→query2) → written to `kv.set('prices', ...)`

**Analysis** (`lib/news.js` `generateSituationReport`): Reads events from KV → DeepSeek LLM → written to `kv.set('analysis', ...)`

### Auth pattern
Protected endpoints (news refresh, reanalyze, retranslate, analysis refresh) use `lib/refreshAuth.js`. It accepts the key via `X-Refresh-Key` header, `Authorization: Bearer <key>`, or `?key=` query param. If `REFRESH_API_KEY` is unset the endpoint returns 503.

`GET /api/polymarket/refresh` is intentionally unprotected (frontend-triggerable) but has a 60-second server-side cooldown to prevent hammering the Polymarket API. It passes an empty token so no translation occurs — translation is handled by scheduled tasks only.

### Testing approach
Tests mock `lib/polymarket` by pre-populating `require.cache` before `require('../server')`. This pattern must be used for any lib that makes external HTTP calls.

### All registration points for sources/assets
When adding or removing a news source or data asset, every one of these locations must be updated:
- `lib/news.js` — RSS feed URL list
- `server.js` — any hardcoded asset/source arrays
- `public/` HTML — legend labels, source filter buttons
- `api/` handlers — if source-specific logic exists

Missing any one of these causes silent failures (data not shown, legend out of sync).

## Data Sources

Before integrating any new RSS feed, verify it is live and has recent entries:

```bash
curl -s "<URL>" | head -80   # check for valid XML and recent dates
```

If the feed returns errors, is Cloudflare-blocked, or has no entries newer than 7 days — stop and report to the user before writing any integration code.

## KV Storage

Two KV implementations share the same `{ get, set }` interface:
- **Local dev**: `lib/localStore.js` (reads/writes JSON files at repo root)
- **Vercel**: `lib/kv.js` (Upstash Redis REST API)

**Never double-serialize.** `kv.set` already calls `JSON.stringify`. Never pass an already-stringified string to it. Always check `lib/kv.js` and `lib/localStore.js` for the current serialization pattern before writing any KV code.

## Debugging UI Issues

For layout or display bugs, **check JavaScript before CSS**. Most layout issues in this codebase (sticky nav, scroll behavior, element visibility) have root causes in JS event handlers or dynamic DOM manipulation — not CSS. Start by searching for JS that references the affected element before attempting any CSS fix.

## LLM Token 使用原则

**核心原则：LLM/翻译 token 只允许在定时任务中消耗，严禁暴露给网页端用户触发。**

### 原因
- DeepSeek API 按 token 计费，网页端用户触发次数不可控
- API key 不得出现在任何前端代码或响应中

### 允许消耗 token 的场景

| 触发方 | 消耗内容 | 实现位置 |
|---|---|---|
| cron `token-refresh.js`（每小时） | 新闻翻译+分析、Polymarket 新问题翻译、战局综述 | `scripts/token-refresh.js` |
| server.js 后台 setInterval | 新闻翻译+分析（每10分钟）、Polymarket 新问题翻译（每5分钟） | `server.js` startup |
| 受保护的管理端点（需 `REFRESH_API_KEY`） | `/api/refresh`、`/api/reanalyze`、`/api/retranslate`、`/api/analysis/refresh` | `server.js` + `lib/refreshAuth.js` |

### 严禁消耗 token 的场景

| 触发方 | 正确做法 |
|---|---|
| 用户点击 Polymarket 刷新按钮 → `/api/polymarket/refresh` | 传空 token，只更新价格/状态，不翻译 |
| Vercel `api/polymarket/refresh.js` | 同上 |
| 任何无需认证的公开 API 端点 | 不得读取或使用 `DEEPSEEK_API_TOKEN` |

### 新增端点时的检查清单
- [ ] 该端点是否有 `requireRefreshAuth` 保护？如无，则**不得**传入 LLM/翻译 token
- [ ] `fetchPolymarketData` 调用：用户可触发路径必须传 `''`，定时任务路径才可传 token
- [ ] API key 不得出现在响应体、日志（完整打印）、或前端 JS 中

## Cron / Scheduled Tasks

All Node.js scripts invoked by cron or launchd **must**:
1. Call `process.exit()` in every code path (including error handlers) — missing this causes zombie processes that silently block future runs
2. Set a hard timeout (e.g. `setTimeout(() => process.exit(1), 5 * 60 * 1000)`) to prevent indefinite hangs
