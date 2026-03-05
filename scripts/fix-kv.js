// 一次性脚本：修复 KV 中被 GitHub Actions 二次序列化的数据
const kv = require('../lib/kv');

async function fixKey(key) {
  const data = await kv.get(key);
  if (Array.isArray(data) && data.length === 1 && typeof data[0] === 'string') {
    console.log(`[${key}] 检测到双重序列化，正在修复...`);
    const real = JSON.parse(data[0]);
    await kv.set(key, real);
    console.log(`[${key}] 修复完成`);
  } else {
    console.log(`[${key}] 格式正常，无需修复`);
  }
}

async function main() {
  await fixKey('events');
  await fixKey('analysis');
  await fixKey('polymarket');
  await fixKey('prices');
}

main().catch(err => { console.error('失败:', err.message); process.exit(1); });
