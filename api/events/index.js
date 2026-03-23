const kv = require('../../lib/kv');

const RECENT_EVENTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  try {
    const events = (await kv.get('events')) || [];
    const cutoffTs = Date.now() - RECENT_EVENTS_WINDOW_MS;
    const recentEvents = events.filter((event) => {
      const ts = Date.parse(event?.pubDate || '');
      return Number.isFinite(ts) && ts >= cutoffTs;
    });

    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
    res.json({
      events: recentEvents,
      total: recentEvents.length,
      truncated: recentEvents.length !== events.length,
      windowDays: 7,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error('[api/events]', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
};
