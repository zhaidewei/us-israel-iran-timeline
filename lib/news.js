/**
 * 新闻抓取、翻译、LLM 分析、战局综述。
 * 所有函数接受 store 参数（{ get, set }），兼容 lib/kv.js 和 lib/localStore.js。
 */
const Parser = require('rss-parser');
const fetch  = require('node-fetch');
const { translateBatch } = require('./translate');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; timeline-bot/1.0)' }
});

// ─── Config ───────────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'BBC中东',      nameKey: 'bbc',      url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: '半岛电视台',   nameKey: 'aljazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: '以色列时报',   nameKey: 'toi',      url: 'https://www.timesofisrael.com/feed/' },
  { name: '卫报',         nameKey: 'guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: '耶路撒冷邮报', nameKey: 'jpost',    url: 'https://www.jpost.com/Rss/RssFeedsHeadlines.aspx' },
  { name: 'France 24',    nameKey: 'france24', url: 'https://www.france24.com/en/middle-east/rss' },
  { name: '中东眼',       nameKey: 'mee',      url: 'https://www.middleeasteye.net/rss' },
  { name: 'Press TV',     nameKey: 'presstv',  url: 'https://www.presstv.ir/rss.xml' },
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isWarRelated(item) {
  // 只用 title + contentSnippet，避免 HTML 内链带入无关关键词
  const text = `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase();
  return GEO_KEYWORDS.some(kw => text.includes(kw)) &&
         ACTION_KEYWORDS.some(kw => text.includes(kw));
}

function applyTimeWindow(events) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return events
    .filter(e => new Date(e.pubDate).getTime() > cutoff)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

// ─── DeepSeek Analysis ────────────────────────────────────────────────────────

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

async function analyzeChunk(articles, clusterRef = new Map(), deepseekToken) {
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
      headers: { 'Authorization': `Bearer ${deepseekToken}`, 'Content-Type': 'application/json' },
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

async function analyzeWithDeepSeek(articles, existingEvents = [], deepseekToken) {
  if (!deepseekToken || !articles.length) return articles;
  const clusterRef = buildClusterRef(existingEvents);
  const BATCH = 15;
  const result = [];
  for (let i = 0; i < articles.length; i += BATCH) {
    result.push(...await analyzeChunk(articles.slice(i, i + BATCH), clusterRef, deepseekToken));
  }
  return result;
}

// ─── RSS Fetch & Refresh ──────────────────────────────────────────────────────

/**
 * 从 RSS 抓取新闻，翻译，LLM 分析，写入 store。
 * @param {object} store  { get(key), set(key, val) } — kv 或 localStore
 * @param {{ deeplToken?: string, deepseekToken?: string }} tokens
 */
async function fetchAndRefresh(store, { deeplToken, deepseekToken } = {}) {
  console.log('\n[新闻] 开始获取 RSS...');
  const existingEvents = (await store.get('events')) || [];
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
  const translatedTitles = await translateBatch(rawNew.map(a => a.titleEn), deeplToken);
  const translated = rawNew.map((a, i) => ({ ...a, titleZh: translatedTitles[i] || a.titleEn }));

  console.log('[LLM] 调用 DeepSeek...');
  const analyzed = await analyzeWithDeepSeek(translated, existingEvents, deepseekToken);

  const merged = applyTimeWindow([...analyzed, ...existingEvents]);
  await store.set('events', merged);
  console.log(`[新闻] 新增 ${rawNew.length} 条，共 ${merged.length} 条\n`);
  return merged;
}

// ─── Situation Report ─────────────────────────────────────────────────────────

/**
 * 生成战局综述，写入 store，并返回结果。
 * @param {object} store
 * @param {string} deepseekToken
 */
async function generateSituationReport(store, deepseekToken) {
  if (!deepseekToken) {
    console.warn('[分析] DEEPSEEK_API_TOKEN 未设置，跳过');
    return await store.get('analysis');
  }

  const events = (await store.get('events')) || [];
  if (!events.length) {
    console.warn('[分析] 无事件，跳过');
    return await store.get('analysis');
  }

  const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
  const recent    = events.filter(e => new Date(e.pubDate).getTime() > cutoff48h);
  const older     = events.filter(e => new Date(e.pubDate).getTime() <= cutoff48h);
  const sample    = [...recent, ...older].slice(0, 80);
  sample.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  const eventList = sample.map((e, i) => {
    const date  = new Date(e.pubDate).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' });
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
      headers: { 'Authorization': `Bearer ${deepseekToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500
      }),
      timeout: 50000
    });
    if (!res.ok) { console.error(`[分析] DeepSeek HTTP ${res.status}`); return await store.get('analysis'); }

    const json    = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) { console.error('[分析] 空响应'); return await store.get('analysis'); }

    const report = JSON.parse(content);
    const result = { ...report, lastUpdated: new Date().toISOString(), basedOnEvents: sample.length };
    await store.set('analysis', result);
    console.log(`[分析] 战局综述已更新（风险等级 ${result.riskLevel}）`);
    return result;
  } catch (err) {
    console.error('[分析] 生成失败:', err.message);
    return await store.get('analysis');
  }
}

module.exports = { fetchAndRefresh, generateSituationReport, analyzeWithDeepSeek };
