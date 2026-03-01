const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const data = await kv.get('analysis');
    res.json(data);
  } catch (err) {
    console.error('[api/analysis]', err.message);
    res.status(500).json({ error: 'Failed to load analysis' });
  }
};
