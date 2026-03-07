const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const data = await kv.get('marketAnalysis');
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=300');
    res.json(data);
  } catch (err) {
    console.error('[api/market-analysis]', err.message);
    res.status(500).json({ error: 'Failed to load market analysis' });
  }
};
