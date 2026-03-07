const fetch = require('node-fetch');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function extractJsonObject(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

function asArray(v) {
  return Array.isArray(v) ? v.filter(Boolean).map(x => String(x)) : [];
}

function normalizeDirection(v) {
  const s = String(v || '').trim();
  return ['上涨', '下跌', '震荡'].includes(s) ? s : '震荡';
}

function normalizePayload(obj, nowIso) {
  const out = obj && typeof obj === 'object' ? obj : {};
  const read = out.asset_read || {};
  return {
    lastUpdated: nowIso,
    window: '最近24小时',
    model: 'deepseek-reasoner',
    overall_sentiment: {
      regime: String(out?.overall_sentiment?.regime || '分化'),
      summary: String(out?.overall_sentiment?.summary || ''),
    },
    asset_read: {
      btc: {
        direction: normalizeDirection(read?.btc?.direction),
        interpretation: String(read?.btc?.interpretation || ''),
      },
      wti: {
        direction: normalizeDirection(read?.wti?.direction),
        interpretation: String(read?.wti?.interpretation || ''),
      },
      gold: {
        direction: normalizeDirection(read?.gold?.direction),
        interpretation: String(read?.gold?.interpretation || ''),
      },
      sp500: {
        direction: normalizeDirection(read?.sp500?.direction),
        interpretation: String(read?.sp500?.interpretation || ''),
      },
    },
    cross_asset_signal: String(out.cross_asset_signal || ''),
    capital_flow_hint: {
      bias: String(out?.capital_flow_hint?.bias || '来回切换'),
      evidence: asArray(out?.capital_flow_hint?.evidence).slice(0, 5),
    },
    next_24h_watchlist: asArray(out.next_24h_watchlist).slice(0, 5),
    confidence: Math.min(5, Math.max(1, Number(out.confidence) || 3)),
  };
}

function buildPrompt(nowIso) {
  return (
    `你是一名宏观与跨资产市场分析师。请对 BTC、WTI原油、黄金、标普500 在最近24小时的走势进行搜索分析，并解读市场情绪与资金动向。\n\n` +
    `当前时间锚点：${nowIso}（Europe/Amsterdam）\n` +
    `分析窗口：仅限最近24小时（相对当前时间锚点）\n\n` +
    `任务要求：\n` +
    `1) 分别判断 BTC / WTI / 黄金 / 标普500 的24小时方向：上涨、下跌或震荡。\n` +
    `2) 解释这四类资产之间的联动关系，识别当前主导叙事（如风险偏好、避险、通胀预期、地缘冲突冲击等）。\n` +
    `3) 给出“市场情绪”和“资金动向”的综合判断。\n` +
    `4) 给出未来24小时最值得关注的3-5个观察点（事件、数据、价格位或风险因子）。\n` +
    `5) 如果信息不足或信号冲突，必须明确写“信息不足/信号冲突”，不要编造具体数值或未验证事实。\n\n` +
    `输出必须是严格 JSON（不要 markdown，不要额外解释）：\n` +
    `{\n` +
    `  "lastUpdated": "ISO时间字符串",\n` +
    `  "window": "最近24小时",\n` +
    `  "overall_sentiment": {\n` +
    `    "regime": "风险偏好|风险厌恶|分化",\n` +
    `    "summary": "2-3句总结"\n` +
    `  },\n` +
    `  "asset_read": {\n` +
    `    "btc": { "direction": "上涨|下跌|震荡", "interpretation": "2-3句" },\n` +
    `    "wti": { "direction": "上涨|下跌|震荡", "interpretation": "2-3句" },\n` +
    `    "gold": { "direction": "上涨|下跌|震荡", "interpretation": "2-3句" },\n` +
    `    "sp500": { "direction": "上涨|下跌|震荡", "interpretation": "2-3句" }\n` +
    `  },\n` +
    `  "cross_asset_signal": "3-5句，说明四资产是否同向或背离，以及背后机制",\n` +
    `  "capital_flow_hint": {\n` +
    `    "bias": "偏风险资产|偏避险资产|来回切换",\n` +
    `    "evidence": ["证据1", "证据2", "证据3"]\n` +
    `  },\n` +
    `  "next_24h_watchlist": ["观察点1", "观察点2", "观察点3"],\n` +
    `  "confidence": 1\n` +
    `}\n\n` +
    `confidence 规则：1=证据弱且冲突多；3=证据中等，有部分冲突；5=证据较强且跨资产一致性高。`
  );
}

async function generateMarketReport(store, deepseekToken, options = {}) {
  const force = Boolean(options.force);
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const existing = (await store.get('marketAnalysis')) || null;

  if (!force && existing?.lastUpdated) {
    const lastTs = Date.parse(existing.lastUpdated);
    if (Number.isFinite(lastTs) && (Date.now() - lastTs) < maxAgeMs) {
      const mins = Math.round((Date.now() - lastTs) / 60000);
      console.log(`[市场解读] 跳过重算：上次更新 ${mins} 分钟前（阈值 ${Math.round(maxAgeMs / 3600000)} 小时）`);
      return existing;
    }
  }

  if (!deepseekToken) {
    console.warn('[市场解读] DEEPSEEK_API_TOKEN 未设置，跳过');
    return existing;
  }

  const nowIso = new Date().toISOString();
  const prompt = buildPrompt(nowIso);
  console.log('[市场解读] 调用 DeepSeek Reasoner 生成报告...');

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deepseekToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1800,
      }),
      timeout: 50000,
    });

    if (!res.ok) {
      console.error(`[市场解读] DeepSeek HTTP ${res.status}`);
      return existing;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);
    if (!parsed) {
      console.error('[市场解读] 解析 JSON 失败');
      return existing;
    }

    const result = normalizePayload(parsed, nowIso);
    await store.set('marketAnalysis', result);
    return result;
  } catch (err) {
    console.error('[市场解读] 生成失败:', err.message);
    return existing;
  }
}

module.exports = { generateMarketReport };
