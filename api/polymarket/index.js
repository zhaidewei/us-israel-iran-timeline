const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const data = (await kv.get('polymarket')) || { lastUpdated: null, markets: [] };
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
    res.json(data);
  } catch (err) {
    console.error('[api/polymarket]', err.message);
    res.status(500).json({ error: 'Failed to load polymarket data' });
  }
};
