// 实时从 Polymarket 拉取并更新 KV 缓存（用户触发，不消耗翻译 token）
const kv = require('../../lib/kv');
const { fetchPolymarketData } = require('../../lib/polymarket');

module.exports = async function handler(req, res) {
  try {
    const data = await fetchPolymarketData(kv, '');
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('[api/polymarket/refresh]', err.message);
    res.status(500).json({ error: err.message });
  }
};
