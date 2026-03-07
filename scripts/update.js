/**
 * 非 Token 数据更新脚本（线上可安全触发对应刷新接口）
 * 仅更新：Polymarket（不翻译）+ 市场价格
 * 输出：Upstash KV
 */
const kv = require('../lib/kv');
const { fetchPolymarketData } = require('../lib/polymarket');
const { fetchMarketPrices }   = require('../lib/prices');

async function main() {
  const startTime = Date.now();
  console.log('=== 开始非Token数据更新 ===', new Date().toISOString());

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('❌ KV_REST_API_URL 或 KV_REST_API_TOKEN 未设置');
    process.exit(1);
  }

  // 明确禁用翻译，避免任何 DeepL 消耗
  await fetchPolymarketData(kv, '');
  await fetchMarketPrices(kv);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 非Token数据更新完成 === ${new Date().toISOString()} （耗时 ${elapsed}s）`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ 更新失败:', err);
    process.exit(1);
  });
