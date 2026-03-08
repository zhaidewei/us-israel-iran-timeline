const fetch = require('node-fetch');
const { translateBatch } = require('./translate');

const POLY_EVENT_SEARCHES = ['Iran', 'Israel', 'Gaza', 'nuclear', 'war'];

const POLY_MARKET_ENDPOINTS = [
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false',
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=startDate&ascending=false',
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=startDate&ascending=false&offset=100',
];

const POLY_RELEVANT_KW = [
  'iran', 'israel', 'idf', 'irgc', 'hamas', 'hezbollah',
  'gaza', 'netanyahu', 'khamenei', 'tehran', 'nuclear deal',
  'middle east', 'west bank', 'rafah', 'beirut', 'strikes on iran',
  'regime change', 'war with iran', 'attack iran', 'bomb iran'
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasKeyword(text, keyword) {
  const kw = keyword.toLowerCase().trim();
  if (!kw) return false;
  const pattern = kw.split(/\s+/).map(escapeRegex).join('\\s+');
  const re = new RegExp(`(^|[^a-z])${pattern}($|[^a-z])`, 'i');
  return re.test(text);
}

function isWarRelatedMarket(m) {
  const q = (m.question || '').toLowerCase();
  return POLY_RELEVANT_KW.some(kw => hasKeyword(q, kw));
}

function parseJsonField(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

/**
 * 从 Polymarket 拉取相关预测市场，翻译问题，写入 KV。
 * @param {object} kv         lib/kv.js 导出的 { get, set }
 * @param {string} translateToken DeepSeek API key（可为空，跳过翻译）
 */
async function fetchPolymarketData(kv, deeplToken) {
  console.log('[Polymarket] 获取预测市场...');
  const seen = new Set();
  const allMarkets = [];

  // Strategy 1: Events API with keyword search
  for (const term of POLY_EVENT_SEARCHES) {
    try {
      const url = `https://gamma-api.polymarket.com/events?search=${encodeURIComponent(term)}&active=true&closed=false&limit=10`;
      const res = await fetch(url, { timeout: 12000, headers: { Accept: 'application/json', 'User-Agent': 'timeline-app/1.0' } });
      if (!res.ok) continue;
      const body = await res.json();
      const events = Array.isArray(body) ? body : (body.events || []);
      for (const ev of events) {
        for (const m of (ev.markets || [])) {
          if (m.conditionId && !seen.has(m.conditionId)) {
            seen.add(m.conditionId);
            if (!m.question) m.question = ev.title || ev.question || '';
            allMarkets.push(m);
          }
        }
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

  // Strategy 2: Broad market fetch, filter locally
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

  const now = new Date();
  const relevant = allMarkets
    .filter(m => {
      if (m.closed) return false;
      if (m.endDate && new Date(m.endDate) < now) return false;
      return isWarRelatedMarket(m);
    })
    .sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0))
    .slice(0, 10);

  console.log(`[Polymarket] 共 ${allMarkets.length} 个 → 过滤后 ${relevant.length} 个`);

  if (relevant.length === 0) {
    console.warn('[Polymarket] 无相关活跃市场，保留缓存');
    return (await kv.get('polymarket')) || { lastUpdated: null, markets: [] };
  }

  const prev = (await kv.get('polymarket')) || { markets: [] };
  const prevMap = new Map((prev.markets || []).map(m => [m.conditionId, m]));

  // 只翻译新增问题（节省 DeepL 配额）
  const needTrans = relevant.filter(m => !prevMap.get(m.conditionId)?.questionZh);
  let transResults = needTrans.map(m => m.question);
  if (needTrans.length && deeplToken) {
    transResults = await translateBatch(needTrans.map(m => m.question), deeplToken);
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
      prevPrices:  prevEntry?.prices || prices,
      volume:      Math.round(parseFloat(m.volume) || 0),
      endDate:     m.endDate || null,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com'
    };
  });

  const result = { lastUpdated: new Date().toISOString(), markets };
  await kv.set('polymarket', result);
  console.log(`[Polymarket] 已更新 ${markets.length} 个市场`);
  return result;
}

module.exports = { fetchPolymarketData };
