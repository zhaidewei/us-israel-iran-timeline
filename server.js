const express = require('express');
const path    = require('path');

const store = require('./lib/localStore');
const { fetchAndRefresh, generateSituationReport, analyzeWithDeepSeek } = require('./lib/news');
const { fetchPolymarketData } = require('./lib/polymarket');
const { fetchMarketPrices }   = require('./lib/prices');
const { requireRefreshAuth } = require('./lib/refreshAuth');

const app  = express();
const PORT = 3000;

const DEEPSEEK_TOKEN = process.env.DEEPSEEK_API_TOKEN;
const tokens = { deeplToken: DEEPSEEK_TOKEN, deepseekToken: DEEPSEEK_TOKEN };

if (!DEEPSEEK_TOKEN) console.warn('[警告] DEEPSEEK_API_TOKEN 未设置');

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// News
app.get('/api/events', async (req, res) => {
  const events = (await store.get('events')) || [];
  res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
});

app.get('/api/refresh', async (req, res) => {
  if (!requireRefreshAuth(req, res)) return;
  try {
    const events = await fetchAndRefresh(store, tokens);
    res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dev utilities
app.get('/api/reanalyze', async (req, res) => {
  if (!requireRefreshAuth(req, res)) return;
  if (!DEEPSEEK_TOKEN) return res.status(400).json({ error: 'DEEPSEEK_API_TOKEN 未设置' });
  try {
    const events = (await store.get('events')) || [];
    const needsAnalysis = events.filter(e => !e.eventCluster);
    if (!needsAnalysis.length) return res.json({ message: '所有事件已有分析', total: events.length });
    const hasCluster = events.filter(e => e.eventCluster);
    const analyzed = await analyzeWithDeepSeek(needsAnalysis, hasCluster, DEEPSEEK_TOKEN);
    const analyzedMap = new Map(analyzed.map(e => [e.id, e]));
    const merged = events.map(e => analyzedMap.get(e.id) || e);
    await store.set('events', merged);
    res.json({ message: `已分析 ${needsAnalysis.length} 条`, total: merged.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/retranslate', async (req, res) => {
  if (!requireRefreshAuth(req, res)) return;
  if (!DEEPSEEK_TOKEN)
    return res.status(400).json({ error: 'DEEPSEEK_API_TOKEN 未设置' });
  try {
    const events = (await store.get('events')) || [];
    // 需要处理：缺少中文标题 或 缺少聚类分析
    const needsWork = events.filter(e => !e.titleZh || e.titleZh === e.titleEn || !e.eventCluster);
    console.log(`[重翻译] 需处理 ${needsWork.length} 条`);
    if (!needsWork.length) return res.json({ message: '所有事件已翻译分析', total: events.length });
    const hasCluster = events.filter(e => e.eventCluster && e.titleZh && e.titleZh !== e.titleEn);
    // analyzeWithDeepSeek 在单次 API 调用中同时完成翻译和分析
    const analyzed = await analyzeWithDeepSeek(needsWork, hasCluster, DEEPSEEK_TOKEN);
    const analyzedMap = new Map(analyzed.map(e => [e.id, e]));
    const finalEvents = events.map(e => analyzedMap.get(e.id) || e);
    await store.set('events', finalEvents);
    res.json({ message: `已处理 ${needsWork.length} 条（翻译+分析合并为单次调用）`, total: finalEvents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analysis
app.get('/api/analysis', async (req, res) => {
  res.json((await store.get('analysis')) || null);
});

app.get('/api/analysis/refresh', async (req, res) => {
  if (!requireRefreshAuth(req, res)) return;
  try {
    res.json(await generateSituationReport(store, DEEPSEEK_TOKEN, { force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polymarket
app.get('/api/polymarket', async (req, res) => {
  res.json((await store.get('polymarket')) || { lastUpdated: null, markets: [] });
});

let lastPolymarketRefresh = 0;
const POLYMARKET_REFRESH_COOLDOWN_MS = 60_000;

app.get('/api/polymarket/refresh', async (req, res) => {
  const now = Date.now();
  if (now - lastPolymarketRefresh < POLYMARKET_REFRESH_COOLDOWN_MS) {
    const retryAfter = Math.ceil((POLYMARKET_REFRESH_COOLDOWN_MS - (now - lastPolymarketRefresh)) / 1000);
    return res.status(429).json({ error: `请稍候 ${retryAfter} 秒后再刷新` });
  }
  lastPolymarketRefresh = now;
  try {
    // 用户触发，不消耗翻译 token；翻译由定时任务负责
    res.json(await fetchPolymarketData(store, ''));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prices
app.get('/api/prices', async (req, res) => {
  res.json((await store.get('prices')) || { lastUpdated: null, assets: [] });
});

app.get('/api/prices/refresh', async (req, res) => {
  try {
    res.json(await fetchMarketPrices(store));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n美以伊战争时间线已启动`);
    console.log(`访问: http://localhost:${PORT}`);
    console.log(`DeepSeek: ${DEEPSEEK_TOKEN ? '✓' : '✗ 未配置'}\n`);

    setTimeout(() => fetchAndRefresh(store, tokens).catch(console.error), 2000);
    setInterval(() => fetchAndRefresh(store, tokens).catch(console.error), 10 * 60 * 1000);

    setTimeout(() => fetchPolymarketData(store, DEEPSEEK_TOKEN).catch(console.error), 6000);
    setInterval(() => fetchPolymarketData(store, DEEPSEEK_TOKEN).catch(console.error), 5 * 60 * 1000);

    setTimeout(() => fetchMarketPrices(store).catch(console.error), 8000);
    setInterval(() => fetchMarketPrices(store).catch(console.error), 15 * 60 * 1000);

    setTimeout(
      () => generateSituationReport(store, DEEPSEEK_TOKEN, { force: false, maxAgeMs: 6 * 60 * 60 * 1000 }).catch(console.error),
      15000
    );
    setInterval(
      () => generateSituationReport(store, DEEPSEEK_TOKEN, { force: false, maxAgeMs: 6 * 60 * 60 * 1000 }).catch(console.error),
      60 * 60 * 1000
    );
  });
}

module.exports = { app, _resetPolymarketCooldown: () => { lastPolymarketRefresh = 0; } };
