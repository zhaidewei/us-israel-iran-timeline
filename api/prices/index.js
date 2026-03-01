const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const data = (await kv.get('prices')) || { lastUpdated: null, assets: [] };
    res.json(data);
  } catch (err) {
    console.error('[api/prices]', err.message);
    res.status(500).json({ error: 'Failed to load prices' });
  }
};
