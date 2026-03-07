const express = require('express');
const path    = require('path');

const store = require('./lib/localStore');
const { fetchAndRefresh, generateSituationReport, analyzeWithDeepSeek } = require('./lib/news');
const { translateBatch }    = require('./lib/translate');
const { fetchPolymarketData } = require('./lib/polymarket');
const { fetchMarketPrices }   = require('./lib/prices');
const { requireRefreshAuth } = require('./lib/refreshAuth');

const app  = express();
const PORT = 3000;

const DEEPL_TOKEN    = process.env.DEEPL_TOKEN;
const DEEPSEEK_TOKEN = process.env.DEEPSEEK_API_TOKEN;
const tokens = { deeplToken: DEEPL_TOKEN, deepseekToken: DEEPSEEK_TOKEN };

if (!DEEPL_TOKEN)    console.warn('[警告] DEEPL_TOKEN 未设置');
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
  if (!DEEPL_TOKEN && !DEEPSEEK_TOKEN)
    return res.status(400).json({ error: 'DEEPL_TOKEN 和 DEEPSEEK_API_TOKEN 均未设置' });
  try {
    const events = (await store.get('events')) || [];
    const needsTrans = events.filter(e => !e.titleZh || e.titleZh === e.titleEn);
    console.log(`[重翻译] 需翻译 ${needsTrans.length} 条`);
    if (needsTrans.length && DEEPL_TOKEN) {
      const translated = await translateBatch(needsTrans.map(e => e.titleEn), DEEPL_TOKEN);
      needsTrans.forEach((e, i) => { e.titleZh = translated[i] || e.titleEn; });
    }
    const transIds = new Set(needsTrans.map(e => e.id));
    const needsAnalysis = events.filter(e => !e.eventCluster || transIds.has(e.id));
    console.log(`[重翻译] 需 LLM 分析 ${needsAnalysis.length} 条`);
    let finalEvents = events;
    if (needsAnalysis.length && DEEPSEEK_TOKEN) {
      const hasCluster = events.filter(e => e.eventCluster && !transIds.has(e.id));
      const analyzed = await analyzeWithDeepSeek(needsAnalysis, hasCluster, DEEPSEEK_TOKEN);
      const analyzedMap = new Map(analyzed.map(e => [e.id, e]));
      finalEvents = events.map(e => analyzedMap.get(e.id) || e);
    }
    await store.set('events', finalEvents);
    res.json({ message: `已修复：翻译 ${needsTrans.length} 条，LLM 分析 ${needsAnalysis.length} 条`, total: finalEvents.length });
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

app.get('/api/polymarket/refresh', async (req, res) => {
  try {
    // 前端可触发的非 token 刷新：禁用 DeepL
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

app.listen(PORT, () => {
  console.log(`\n美以伊战争时间线已启动`);
  console.log(`访问: http://localhost:${PORT}`);
  console.log(`DeepL:    ${DEEPL_TOKEN    ? '✓' : '✗ 未配置'}`);
  console.log(`DeepSeek: ${DEEPSEEK_TOKEN ? '✓' : '✗ 未配置'}\n`);

  setTimeout(() => fetchAndRefresh(store, tokens).catch(console.error), 2000);
  setInterval(() => fetchAndRefresh(store, tokens).catch(console.error), 10 * 60 * 1000);

  setTimeout(() => fetchPolymarketData(store, DEEPL_TOKEN).catch(console.error), 6000);
  setInterval(() => fetchPolymarketData(store, DEEPL_TOKEN).catch(console.error), 5 * 60 * 1000);

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
