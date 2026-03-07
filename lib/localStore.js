/**
 * 本地文件存储 —— 与 lib/kv.js 接口相同，供 server.js 本地开发使用。
 * get/set 均返回 Promise，可直接替换 kv 传入各 lib 函数。
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILE_MAP = {
  events:     'events.json',
  polymarket: 'polymarket.json',
  prices:     'prices.json',
  analysis:   'analysis.json',
  marketAnalysis: 'market-analysis.json',
};

async function get(key) {
  const file = FILE_MAP[key];
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
  catch { return null; }
}

async function set(key, value) {
  const file = FILE_MAP[key];
  if (!file) return;
  fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2), 'utf8');
}

module.exports = { get, set };
