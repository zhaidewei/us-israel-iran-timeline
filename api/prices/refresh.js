// 实时从 Yahoo Finance 拉取行情并更新 KV 缓存（免费 API，允许用户触发）
const kv = require('../../lib/kv');
const { fetchMarketPrices } = require('../../lib/prices');

module.exports = async function handler(req, res) {
  try {
    const data = await fetchMarketPrices(kv);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('[api/prices/refresh]', err.message);
    res.status(500).json({ error: err.message });
  }
};
