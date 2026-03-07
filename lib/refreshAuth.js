function getExpectedKey() {
  return process.env.REFRESH_API_KEY || process.env.CRON_SECRET || '';
}

function getProvidedKey(req) {
  const headers = req?.headers || {};
  const direct = headers['x-refresh-key'] || headers['X-Refresh-Key'];
  if (direct) return String(direct).trim();

  const auth = headers.authorization || headers.Authorization || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();

  const queryKey = req?.query?.key || req?.query?.refreshKey;
  if (queryKey) return String(queryKey).trim();
  return '';
}

function requireRefreshAuth(req, res) {
  const expected = getExpectedKey();
  if (!expected) {
    res.status(503).json({ error: 'REFRESH_API_KEY 未设置，刷新接口已禁用' });
    return false;
  }
  const provided = getProvidedKey(req);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized refresh request' });
    return false;
  }
  return true;
}

module.exports = { requireRefreshAuth };
