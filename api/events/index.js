const kv = require('../../lib/kv');

module.exports = async function handler(req, res) {
  try {
    const events = (await kv.get('events')) || [];
    res.json({ events, total: events.length, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[api/events]', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
};
