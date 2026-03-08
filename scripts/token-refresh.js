/**
 * Token 消耗任务专用脚本（DeepL / DeepSeek）
 *
 * 用法：
 *   node scripts/token-refresh.js --target=local
 *   node scripts/token-refresh.js --target=kv
 *
 * 说明：
 * - 必须显式提供 --target，防止误写入
 * - local: 写入本地 JSON
 * - kv:    写入远端 Upstash KV
 */
const localStore = require('../lib/localStore');
const kv = require('../lib/kv');
const { fetchAndRefresh, generateSituationReport } = require('../lib/news');
const { fetchPolymarketData } = require('../lib/polymarket');

function parseTarget(argv) {
  const arg = argv.find(a => a.startsWith('--target='));
  if (!arg) return '';
  return String(arg.split('=')[1] || '').trim().toLowerCase();
}

function resolveStore(target) {
  if (target === 'local') return localStore;
  if (target === 'kv') return kv;
  return null;
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  const store = resolveStore(target);
  if (!store) {
    console.error('❌ 缺少或非法 --target，必须是 --target=local 或 --target=kv');
    process.exit(1);
  }

  const DEEPSEEK_TOKEN = process.env.DEEPSEEK_API_TOKEN || '';

  if (!DEEPSEEK_TOKEN) console.warn('⚠ DEEPSEEK_API_TOKEN 未设置，翻译和 LLM 分析将跳过');

  if (target === 'kv' && (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)) {
    console.error('❌ --target=kv 需要 KV_REST_API_URL 和 KV_REST_API_TOKEN');
    process.exit(1);
  }

  const start = Date.now();
  console.log(`=== 开始Token任务（target=${target}）===`, new Date().toISOString());

  await fetchAndRefresh(store, { deeplToken: DEEPSEEK_TOKEN, deepseekToken: DEEPSEEK_TOKEN });
  await generateSituationReport(store, DEEPSEEK_TOKEN, { force: false, maxAgeMs: 6 * 60 * 60 * 1000 });
  await fetchPolymarketData(store, DEEPSEEK_TOKEN);

  const sec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`=== Token任务完成（target=${target}）=== ${new Date().toISOString()} （耗时 ${sec}s）`);
}

main().catch(err => {
  console.error('❌ Token任务失败:', err);
  process.exit(1);
});
