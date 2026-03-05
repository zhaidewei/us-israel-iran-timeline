/**
 * 定时数据更新脚本 — 由 crontab 调用，写入 Upstash KV
 */
const kv = require('../lib/kv');
const { fetchAndRefresh, generateSituationReport } = require('../lib/news');
const { fetchPolymarketData } = require('../lib/polymarket');
const { fetchMarketPrices }   = require('../lib/prices');

const DEEPL_TOKEN    = process.env.DEEPL_TOKEN;
const DEEPSEEK_TOKEN = process.env.DEEPSEEK_API_TOKEN;

async function main() {
  const startTime = Date.now();
  console.log('=== 开始数据更新 ===', new Date().toISOString());

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('❌ KV_REST_API_URL 或 KV_REST_API_TOKEN 未设置');
    process.exit(1);
  }

  if (!DEEPL_TOKEN)    console.warn('⚠ DEEPL_TOKEN 未设置，跳过翻译');
  if (!DEEPSEEK_TOKEN) console.warn('⚠ DEEPSEEK_API_TOKEN 未设置，跳过 LLM 分析');

  await fetchAndRefresh(kv, { deeplToken: DEEPL_TOKEN, deepseekToken: DEEPSEEK_TOKEN });
  await generateSituationReport(kv, DEEPSEEK_TOKEN);
  await fetchPolymarketData(kv, DEEPL_TOKEN);
  await fetchMarketPrices(kv);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 数据更新完成 === ${new Date().toISOString()} （耗时 ${elapsed}s）`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ 更新失败:', err);
    process.exit(1);
  });
