const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const events = (await kv.get('events')) || [];
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
    res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[api/events]', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
};
