/**
 * 轻量 Upstash REST API 封装（Vercel KV 底层即 Upstash）
 * 环境变量：KV_REST_API_URL、KV_REST_API_TOKEN
 * 无额外依赖，复用项目已有的 node-fetch
 */
const fetch = require('node-fetch');

// 兼容 Vercel KV 和 Upstash Redis Marketplace 两种环境变量命名
function url()   { return process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL; }
function token() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }

async function get(key) {
  const res = await fetch(`${url()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token()}` }
  });
  if (!res.ok) throw new Error(`KV GET failed: ${res.status}`);
  const { result } = await res.json();
  if (result == null) return null;
  try { return JSON.parse(result); }
  catch { return result; }
}

async function set(key, value) {
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  const res = await fetch(`${url()}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'text/plain'
    },
    body: valueStr
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
  const { result } = await res.json();
  return result === 'OK';
}

module.exports = { get, set };
