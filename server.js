const express = require('express');
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; timeline-bot/1.0)' } });
const EVENTS_FILE     = path.join(__dirname, 'events.json');
const POLYMARKET_FILE = path.join(__dirname, 'polymarket.json');
const PRICES_FILE     = path.join(__dirname, 'prices.json');
const ANALYSIS_FILE   = path.join(__dirname, 'analysis.json');
const PORT = 3000;

const DEEPL_TOKEN    = process.env.DEEPL_TOKEN;
const DEEPSEEK_TOKEN = process.env.DEEPSEEK_API_TOKEN;

if (!DEEPL_TOKEN)    console.warn('[警告] DEEPL_TOKEN 未设置');
if (!DEEPSEEK_TOKEN) console.warn('[警告] DEEPSEEK_API_TOKEN 未设置');

// ─── RSS Config ───────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'BBC中东',      nameKey: 'bbc',      url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: '半岛电视台',   nameKey: 'aljazeera',url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: '以色列时报',   nameKey: 'toi',      url: 'https://www.timesofisrael.com/feed/' },
  { name: '卫报',         nameKey: 'guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: '耶路撒冷邮报', nameKey: 'jpost',    url: 'https://www.jpost.com/Rss/RssFeedsHeadlines.aspx' },
  { name: 'France 24',    nameKey: 'france24', url: 'https://www.france24.com/en/middle-east/rss' },
  { name: '中东眼',       nameKey: 'mee',      url: 'https://www.middleeasteye.net/rss' },
  // 伊朗方面
  { name: 'Press TV',     nameKey: 'presstv',  url: 'https://www.presstv.ir/rss.xml' },
  { name: 'IFP News',     nameKey: 'irna',     url: 'https://ifpnews.com/feed' },
  // 俄罗斯方面
  { name: 'TASS',         nameKey: 'tass',     url: 'https://tass.com/rss/v2.xml' },
];

const GEO_KEYWORDS = [
  'israel', 'iran', 'gaza', 'tehran', 'idf', 'irgc',
  'khamenei', 'netanyahu', 'hezbollah', 'hamas', 'rafah',
  'west bank', 'beirut', 'pentagon'
];
const ACTION_KEYWORDS = [
  'missile', 'strike', 'attack', 'bomb', 'drone',
  'airstrike', 'nuclear', 'war', 'ceasefire', 'hostage',
  'sanction', 'retaliation', 'intercept', 'killed', 'kills'
];

// ─── News Helpers ─────────────────────────────────────────────────────────────

function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
}

function isWarRelated(item) {
  const text = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`.toLowerCase();
  return GEO_KEYWORDS.some(kw => text.includes(kw)) &&
         ACTION_KEYWORDS.some(kw => text.includes(kw));
}

function applyTimeWindow(events) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return events
    .filter(e => new Date(e.pubDate).getTime() > cutoff)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

// ─── DeepL Translation ────────────────────────────────────────────────────────

function deepLEndpoint() {
  return DEEPL_TOKEN?.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
}

async function translateBatch(texts) {
  if (!texts.length || !DEEPL_TOKEN) return texts;
  const nonEmpty = texts.map((t, i) => ({ t, i })).filter(x => x.t && x.t.trim());
  if (!nonEmpty.length) return texts;
  try {
    const res = await fetch(deepLEndpoint(), {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: nonEmpty.map(x => x.t), target_lang: 'ZH' }),
      timeout: 15000
    });
    if (!res.ok) { console.error(`[DeepL] HTTP ${res.status}`); return texts; }
    const json = await res.json();
    const out = [...texts];
    json.translations.forEach((tr, idx) => { out[nonEmpty[idx].i] = tr.text; });
    return out;
  } catch (err) {
    console.error('[DeepL] 翻译失败:', err.message);
    return texts;
  }
}

// ─── DeepSeek LLM Analysis ────────────────────────────────────────────────────

function buildClusterRef(existingEvents) {
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const ref = new Map();
  for (const e of existingEvents) {
    if (e.eventCluster && new Date(e.pubDate).getTime() > cutoff24h) {
      if (!ref.has(e.eventCluster)) ref.set(e.eventCluster, e.titleZh || e.titleEn);
    }
  }
  return ref;
}

async function analyzeWithDeepSeek(articles, existingEvents = []) {
  if (!DEEPSEEK_TOKEN || !articles.length) return articles;
  const clusterRef = buildClusterRef(existingEvents);
  const BATCH = 15;
  const result = [];
  for (let i = 0; i < articles.length; i += BATCH) {
    result.push(...await analyzeChunk(articles.slice(i, i + BATCH), clusterRef));
  }
  return result;
}

async function analyzeChunk(articles, clusterRef = new Map()) {
  const existingCtx = clusterRef.size > 0
    ? `\n已有事件聚类（新文章若属同一事件请复用其 key）：\n` +
      Array.from(clusterRef.entries()).slice(0, 20)
        .map(([k, t]) => `  "${k}" → ${t}`).join('\n') + '\n'
    : '';

  const list = articles
    .map((a, i) => `[${i}] ${a.titleZh || a.titleEn}\n原文摘要：${(a.summaryEn || '').slice(0, 150)}`)
    .join('\n\n');

  const prompt =
    `你是中东冲突新闻分析助手。分析以下 ${articles.length} 篇新闻，返回 JSON。${existingCtx}\n` +
    `每篇文章返回：\n` +
    `1. eventCluster：事件聚类 key（英文，格式：主题-月日，如 "us-iran-strike-0228"；同一事件复用已有 key）\n` +
    `2. category：军事打击 / 防空拦截 / 外交动向 / 人员伤亡 / 制裁经济 / 内政局势 / 其他\n` +
    `3. importance：1-5（5=重大突发，4=重要，3=常规，2=背景，1=次要）\n` +
    `4. briefZh：30-50字中文战报摘要，简洁客观；信息不足时留空字符串\n\n` +
    `新闻列表：\n${list}\n\n` +
    `严格返回（数组长度必须为 ${articles.length}）：\n` +
    `{"results":[{"eventCluster":"...","category":"...","importance":3,"briefZh":"..."},...]}`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DEEPSEEK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 2000
      }),
      timeout: 40000
    });
    if (!res.ok) { console.error(`[DeepSeek] HTTP ${res.status}`); return articles; }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) return articles;

    const results = JSON.parse(content).results;
    if (!Array.isArray(results) || results.length !== articles.length) {
      console.error('[DeepSeek] 返回数组长度不匹配');
      return articles;
    }

    return articles.map((a, i) => ({
      ...a,
      eventCluster: results[i]?.eventCluster || `solo-${a.id}`,
      category:     results[i]?.category     || '其他',
      importance:   typeof results[i]?.importance === 'number' ? results[i].importance : 3,
      briefZh:      results[i]?.briefZh      || ''
    }));
  } catch (err) {
    console.error('[DeepSeek] 分析失败:', err.message);
    return articles;
  }
}

// ─── News Fetch ───────────────────────────────────────────────────────────────

async function fetchAndRefresh() {
  console.log('\n[新闻] 开始获取 RSS...');
  const existingEvents = loadEvents();
  const existingIds = new Set(existingEvents.map(e => e.id));
  const rawNew = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  [${feed.name}] 获取中...`);
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items) {
        if (!isWarRelated(item)) continue;
        const id = `${feed.nameKey}-${item.guid || item.link || item.title}`;
        if (existingIds.has(id)) continue;
        rawNew.push({
          id,
          source:    feed.name,
          sourceKey: feed.nameKey,
          titleEn:   item.title || '',
          summaryEn: (item.contentSnippet || item.summary || '').slice(0, 400),
          link:      item.link || '',
          pubDate:   item.pubDate || item.isoDate || new Date().toISOString(),
          fetchedAt: new Date().toISOString()
        });
        existingIds.add(id);
      }
    } catch (err) {
      console.error(`  [${feed.name}] 失败: ${err.message}`);
    }
  }

  if (!rawNew.length) {
    console.log('[新闻] 无新文章');
    return applyTimeWindow(existingEvents);
  }

  console.log(`[翻译] ${rawNew.length} 条，调用 DeepL...`);
  const translatedTitles = await translateBatch(rawNew.map(a => a.titleEn));
  const translated = rawNew.map((a, i) => ({ ...a, titleZh: translatedTitles[i] || a.titleEn }));

  console.log('[LLM] 调用 DeepSeek...');
  const analyzed = await analyzeWithDeepSeek(translated, existingEvents);

  const merged = applyTimeWindow([...analyzed, ...existingEvents]);
  saveEvents(merged);
  console.log(`[新闻] 新增 ${rawNew.length} 条，共 ${merged.length} 条\n`);
  return merged;
}

// ─── Polymarket ───────────────────────────────────────────────────────────────

function loadPolyCache() {
  try { return JSON.parse(fs.readFileSync(POLYMARKET_FILE, 'utf8')); }
  catch { return { lastUpdated: null, markets: [] }; }
}

function savePolyCache(data) {
  fs.writeFileSync(POLYMARKET_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Events API search terms (events group related markets and search works better here)
const POLY_EVENT_SEARCHES = ['Iran', 'Israel', 'Gaza', 'nuclear', 'war'];

// Fallback: broad market endpoints filtered locally
const POLY_MARKET_ENDPOINTS = [
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false',
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=startDate&ascending=false',
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=startDate&ascending=false&offset=100',
];

// Post-fetch keyword filter applied to the question text
// The Gamma API search is fuzzy — this ensures we only show genuinely relevant markets
const POLY_RELEVANT_KW = [
  'iran', 'israel', 'idf', 'irgc', 'hamas', 'hezbollah',
  'gaza', 'netanyahu', 'khamenei', 'tehran', 'nuclear deal',
  'middle east', 'west bank', 'rafah', 'beirut', 'strikes on iran',
  'regime change', 'war with iran', 'attack iran', 'bomb iran'
];

function isWarRelatedMarket(m) {
  const q = (m.question || '').toLowerCase();
  return POLY_RELEVANT_KW.some(kw => q.includes(kw));
}

function parseJsonField(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

async function fetchPolymarketData() {
  console.log('[Polymarket] 获取预测市场...');
  const seen = new Set();
  const allMarkets = [];

  // ── Strategy 1: Events API with keyword search (often indexes topics better) ──
  for (const term of POLY_EVENT_SEARCHES) {
    try {
      const url = `https://gamma-api.polymarket.com/events?search=${encodeURIComponent(term)}&active=true&closed=false&limit=10`;
      const res = await fetch(url, { timeout: 12000, headers: { Accept: 'application/json', 'User-Agent': 'timeline-app/1.0' } });
      if (!res.ok) continue;
      const body = await res.json();
      const events = Array.isArray(body) ? body : (body.events || []);
      for (const ev of events) {
        // Each event may contain nested markets
        for (const m of (ev.markets || [])) {
          if (m.conditionId && !seen.has(m.conditionId)) {
            seen.add(m.conditionId);
            if (!m.question) m.question = ev.title || ev.question || '';
            allMarkets.push(m);
          }
        }
        // Also treat the event itself as a market object
        const eid = ev.id || ev.conditionId;
        if (eid && !seen.has(eid)) {
          seen.add(eid);
          allMarkets.push({
            conditionId: eid,
            question: ev.title || ev.question || '',
            outcomePrices: ev.outcomePrices,
            outcomes: ev.outcomes,
            volume: ev.volume,
            endDate: ev.endDate,
            active: ev.active,
            closed: ev.closed,
            slug: ev.slug
          });
        }
      }
    } catch (err) {
      console.error(`[Polymarket] Events API "${term}" 失败:`, err.message);
    }
  }

  // ── Strategy 2: Broad market fetch, filter locally ──
  for (const url of POLY_MARKET_ENDPOINTS) {
    try {
      const res = await fetch(url, { timeout: 15000, headers: { Accept: 'application/json', 'User-Agent': 'timeline-app/1.0' } });
      if (!res.ok) continue;
      const body = await res.json();
      const markets = Array.isArray(body) ? body : (body.markets || []);
      for (const m of markets) {
        if (m.conditionId && !seen.has(m.conditionId)) {
          seen.add(m.conditionId);
          allMarkets.push(m);
        }
      }
    } catch (err) {
      console.error('[Polymarket] Markets API 失败:', err.message);
    }
  }

  // Local keyword filter — no volume floor (new war markets may be low-volume)
  const now = new Date();
  const relevant = allMarkets
    .filter(m => {
      if (m.closed) return false;
      if (m.endDate && new Date(m.endDate) < now) return false;
      return isWarRelatedMarket(m);
    })
    .sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0))
    .slice(0, 10);

  console.log(`[Polymarket] 共抓取 ${allMarkets.length} 个市场 → 关键词过滤后 ${relevant.length} 个`);

  if (relevant.length === 0) {
    console.log('[Polymarket] 市场标题样本（前10，调试用）:');
    allMarkets.slice(0, 10).forEach((m, i) =>
      console.log(`  [${i + 1}] ${(m.question || '').slice(0, 90)}`));
    console.warn('[Polymarket] 无相关活跃市场，保留缓存');
    return loadPolyCache();
  }

  // Load previous cache for trend comparison + translation reuse
  const prev = loadPolyCache();
  const prevMap = new Map((prev.markets || []).map(m => [m.conditionId, m]));

  // Translate only new questions (save DeepL quota)
  const needTrans = relevant.filter(m => !prevMap.get(m.conditionId)?.questionZh);
  let transResults = needTrans.map(m => m.question);
  if (needTrans.length && DEEPL_TOKEN) {
    transResults = await translateBatch(needTrans.map(m => m.question));
  }
  const transMap = new Map(needTrans.map((m, i) => [m.conditionId, transResults[i] || m.question]));

  const markets = relevant.map(m => {
    const prices   = parseJsonField(m.outcomePrices, []).map(Number).filter(n => !isNaN(n));
    const outcomes = parseJsonField(m.outcomes, ['Yes', 'No']);
    const prevEntry = prevMap.get(m.conditionId);
    const questionZh = prevEntry?.questionZh || transMap.get(m.conditionId) || m.question;

    return {
      conditionId: m.conditionId,
      question:    m.question,
      questionZh,
      outcomes,
      prices,
      prevPrices:  prevEntry?.prices || prices,   // for trend arrows
      volume:      Math.round(parseFloat(m.volume) || 0),
      endDate:     m.endDate || null,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com'
    };
  });

  const result = { lastUpdated: new Date().toISOString(), markets };
  savePolyCache(result);
  console.log(`[Polymarket] 已更新 ${markets.length} 个市场`);
  return result;
}

// ─── Market Prices ────────────────────────────────────────────────────────────

const PRICE_ASSETS = [
  { symbol: 'CL=F',     nameZh: 'WTI原油',  unit: '$/桶', id: 'oil', color: '#f97316' },
  { symbol: 'DX-Y.NYB', nameZh: '美元指数', unit: 'DXY',  id: 'dxy', color: '#3b82f6' },
  { symbol: 'BTC-USD',  nameZh: '比特币',   unit: '$',    id: 'btc', color: '#f59e0b' },
];

function loadPricesCache() {
  try { return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')); }
  catch { return { lastUpdated: null, assets: [] }; }
}

function savePricesCache(data) {
  fs.writeFileSync(PRICES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchAssetHistory(asset) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?interval=1h&range=7d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?interval=1h&range=7d`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        }
      });
      if (!res.ok) { console.error(`[价格] ${asset.symbol} HTTP ${res.status}`); continue; }
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) continue;

      const timestamps = result.timestamp || [];
      const closes     = result.indicators?.quote?.[0]?.close || [];
      const meta       = result.meta || {};

      const history = timestamps
        .map((t, i) => ({ time: t * 1000, value: closes[i] }))
        .filter(p => p.value != null && !isNaN(p.value))
        .slice(-168); // max 168 data points (7 days × 24h)

      if (!history.length) continue;

      const currentPrice = meta.regularMarketPrice ?? history[history.length - 1].value;
      const prevClose    = meta.chartPreviousClose  ?? history[0].value;
      const change       = currentPrice - prevClose;
      const changePct    = prevClose ? (change / prevClose) * 100 : 0;

      return { id: asset.id, symbol: asset.symbol, nameZh: asset.nameZh,
               unit: asset.unit, color: asset.color,
               currentPrice, change, changePct, history };
    } catch (err) {
      console.error(`[价格] ${asset.symbol} 失败:`, err.message);
    }
  }
  return null;
}

async function fetchMarketPrices() {
  console.log('[价格] 获取市场行情...');
  const results = await Promise.all(PRICE_ASSETS.map(fetchAssetHistory));
  const assets  = results.filter(Boolean);
  console.log(`[价格] 成功 ${assets.length}/${PRICE_ASSETS.length} 个资产`);
  if (!assets.length) {
    console.warn('[价格] 无数据，保留缓存');
    return loadPricesCache();
  }
  const data = { lastUpdated: new Date().toISOString(), assets };
  savePricesCache(data);
  return data;
}

// ─── Situation Analysis ───────────────────────────────────────────────────────

function loadAnalysis() {
  try { return JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf8')); }
  catch { return null; }
}

function saveAnalysis(data) {
  fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function generateSituationReport() {
  if (!DEEPSEEK_TOKEN) { console.warn('[分析] DEEPSEEK_API_TOKEN 未设置，跳过'); return loadAnalysis(); }

  const events = loadEvents();
  if (!events.length) { console.warn('[分析] 无事件，跳过'); return loadAnalysis(); }

  // 取最近48小时优先 + 补充更早事件，最多60条
  const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
  const recent    = events.filter(e => new Date(e.pubDate).getTime() > cutoff48h);
  const older     = events.filter(e => new Date(e.pubDate).getTime() <= cutoff48h);
  const sample    = [...recent, ...older].slice(0, 60);

  // 按时间正序排列，方便 LLM 理解时间线
  sample.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  const eventList = sample.map((e, i) => {
    const date = new Date(e.pubDate).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' });
    const title = e.titleZh || e.titleEn;
    const brief = e.briefZh ? `（${e.briefZh}）` : '';
    const cat   = e.category ? `[${e.category}]` : '';
    return `${i + 1}. ${date} ${cat} ${title}${brief}`;
  }).join('\n');

  const prompt =
    `你是中东军事冲突分析专家。以下是关于美国/以色列 vs 伊朗冲突的最新新闻事件列表（按时间正序）。\n\n` +
    `事件列表（共 ${sample.length} 条）：\n${eventList}\n\n` +
    `请基于以上事件，生成一份结构化战局综述，严格返回以下 JSON 格式：\n` +
    `{\n` +
    `  "riskLevel": 1-5整数（1=紧张对峙, 3=局部冲突, 5=全面战争）,\n` +
    `  "riskLabel": "简短风险描述，如"全面战争"",\n` +
    `  "overview": "100-150字整体态势概述，客观简洁",\n` +
    `  "phases": [\n` +
    `    { "label": "阶段名称", "dateRange": "日期范围", "summary": "40-60字描述" }\n` +
    `  ],\n` +
    `  "actors": [\n` +
    `    { "name": "方名称", "stance": "一句话立场", "emoji": "一个代表emoji" }\n` +
    `  ],\n` +
    `  "keySignals": [\n` +
    `    { "signal": "关键信号或转折点", "implication": "含义" }\n` +
    `  ],\n` +
    `  "trajectory": "60-80字走向研判，包括最可能的后续发展",\n` +
    `  "watchPoints": ["值得关注的变量1", "值得关注的变量2", "值得关注的变量3"]\n` +
    `}\n` +
    `phases 1-4个，actors 包含以色列/伊朗/美国（如有涉及），keySignals 2-4个，watchPoints 3个。`;

  console.log(`[分析] 调用 DeepSeek 生成战局综述（基于 ${sample.length} 条事件）...`);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DEEPSEEK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500
      }),
      timeout: 50000
    });
    if (!res.ok) { console.error(`[分析] DeepSeek HTTP ${res.status}`); return loadAnalysis(); }

    const json    = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) { console.error('[分析] 空响应'); return loadAnalysis(); }

    const report  = JSON.parse(content);
    const result  = { ...report, lastUpdated: new Date().toISOString(), basedOnEvents: sample.length };
    saveAnalysis(result);
    console.log(`[分析] 战局综述已更新（风险等级 ${result.riskLevel}）`);
    return result;
  } catch (err) {
    console.error('[分析] 生成失败:', err.message);
    return loadAnalysis();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// News routes
app.get('/api/events', (req, res) => {
  const events = loadEvents();
  res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
});

app.get('/api/refresh', async (req, res) => {
  try {
    const events = await fetchAndRefresh();
    res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reanalyze', async (req, res) => {
  if (!DEEPSEEK_TOKEN) return res.status(400).json({ error: 'DEEPSEEK_API_TOKEN 未设置' });
  try {
    const events = loadEvents();
    const needsAnalysis = events.filter(e => !e.eventCluster);
    if (!needsAnalysis.length) return res.json({ message: '所有事件已有分析', total: events.length });
    const hasCluster = events.filter(e => e.eventCluster);
    const analyzed = await analyzeWithDeepSeek(needsAnalysis, hasCluster);
    const analyzedMap = new Map(analyzed.map(e => [e.id, e]));
    const merged = events.map(e => analyzedMap.get(e.id) || e);
    saveEvents(merged);
    res.json({ message: `已分析 ${needsAnalysis.length} 条`, total: merged.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 修复无 token 时缓存的未翻译 + 未分析事件
app.get('/api/retranslate', async (req, res) => {
  if (!DEEPL_TOKEN && !DEEPSEEK_TOKEN)
    return res.status(400).json({ error: 'DEEPL_TOKEN 和 DEEPSEEK_API_TOKEN 均未设置' });
  try {
    const events = loadEvents();

    // 需要重翻译：titleZh 缺失 或 与 titleEn 相同
    const needsTrans = events.filter(e => !e.titleZh || e.titleZh === e.titleEn);
    console.log(`[重翻译] 需翻译 ${needsTrans.length} 条`);
    if (needsTrans.length && DEEPL_TOKEN) {
      const translated = await translateBatch(needsTrans.map(e => e.titleEn));
      needsTrans.forEach((e, i) => { e.titleZh = translated[i] || e.titleEn; });
    }

    // 需要重分析：缺少 eventCluster（含刚刚翻译完的 + 原来就缺的）
    const transIds = new Set(needsTrans.map(e => e.id));
    const needsAnalysis = events.filter(e => !e.eventCluster || transIds.has(e.id));
    console.log(`[重翻译] 需 LLM 分析 ${needsAnalysis.length} 条`);
    let finalEvents = events;
    if (needsAnalysis.length && DEEPSEEK_TOKEN) {
      const hasCluster = events.filter(e => e.eventCluster && !transIds.has(e.id));
      const analyzed = await analyzeWithDeepSeek(needsAnalysis, hasCluster);
      const analyzedMap = new Map(analyzed.map(e => [e.id, e]));
      finalEvents = events.map(e => analyzedMap.get(e.id) || e);
    }

    saveEvents(finalEvents);
    res.json({
      message: `已修复：翻译 ${needsTrans.length} 条，LLM 分析 ${needsAnalysis.length} 条`,
      total: finalEvents.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analysis routes
app.get('/api/analysis', (req, res) => {
  const data = loadAnalysis();
  if (!data) return res.json(null);
  res.json(data);
});

app.get('/api/analysis/refresh', async (req, res) => {
  try {
    const data = await generateSituationReport();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polymarket routes
app.get('/api/polymarket', (req, res) => {
  res.json(loadPolyCache());
});

app.get('/api/polymarket/refresh', async (req, res) => {
  try {
    const data = await fetchPolymarketData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prices routes
app.get('/api/prices', (req, res) => {
  res.json(loadPricesCache());
});

app.get('/api/prices/refresh', async (req, res) => {
  try {
    const data = await fetchMarketPrices();
    res.json(data);
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

  // News: initial fetch after 2s, then every 10 min
  setTimeout(() => fetchAndRefresh().catch(console.error), 2000);
  setInterval(() => fetchAndRefresh().catch(console.error), 10 * 60 * 1000);

  // Polymarket: initial fetch after 6s, then every 5 min
  setTimeout(() => fetchPolymarketData().catch(console.error), 6000);
  setInterval(() => fetchPolymarketData().catch(console.error), 5 * 60 * 1000);

  // Prices: initial fetch after 8s, then every 15 min
  setTimeout(() => fetchMarketPrices().catch(console.error), 8000);
  setInterval(() => fetchMarketPrices().catch(console.error), 15 * 60 * 1000);

  // Analysis: initial after 15s (wait for news to load first), then every 60 min
  setTimeout(() => generateSituationReport().catch(console.error), 15000);
  setInterval(() => generateSituationReport().catch(console.error), 60 * 60 * 1000);
});
