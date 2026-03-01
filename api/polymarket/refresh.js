// 实时从 Polymarket 拉取并更新 KV 缓存（免费 API，允许用户触发）
const kv = require('../../lib/kv');
const { fetchPolymarketData } = require('../../lib/polymarket');

module.exports = async function handler(req, res) {
  try {
    const data = await fetchPolymarketData(kv, process.env.DEEPL_TOKEN);
    res.json(data);
  } catch (err) {
    console.error('[api/polymarket/refresh]', err.message);
    res.status(500).json({ error: err.message });
  }
};
