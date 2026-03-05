/**
 * 从 Upstash KV 拉取线上数据到本地 JSON 文件
 * 用法: node scripts/dump-kv.js
 */
const fs   = require('fs');
const path = require('path');

// 加载 .env.vercel
const envFile = path.join(__dirname, '..', '.env.vercel');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=["']?([^"'\n]*)["']?/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const kv   = require('../lib/kv');
const ROOT = path.join(__dirname, '..');

const KEYS = [
  { key: 'events',     file: 'events.json' },
  { key: 'analysis',   file: 'analysis.json' },
  { key: 'polymarket', file: 'polymarket.json' },
  { key: 'prices',     file: 'prices.json' },
];

(async () => {
  console.log(`[dump] 连接 ${process.env.KV_REST_API_URL}\n`);
  for (const { key, file } of KEYS) {
    try {
      const data = await kv.get(key);
      if (data == null) {
        console.log(`  ${key}: 空（跳过）`);
        continue;
      }
      const outPath = path.join(ROOT, file);
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
      const count = Array.isArray(data) ? `${data.length} 条` : '1 对象';
      console.log(`  ${key}: ${count} → ${file}`);
    } catch (err) {
      console.error(`  ${key}: 失败 — ${err.message}`);
    }
  }
  console.log('\n[dump] 完成，可以运行 node server.js');
})();
