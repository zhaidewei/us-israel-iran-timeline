const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const data = (await kv.get('prices')) || { lastUpdated: null, assets: [] };
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=90');
    res.json(data);
  } catch (err) {
    console.error('[api/prices]', err.message);
    res.status(500).json({ error: 'Failed to load prices' });
  }
};
