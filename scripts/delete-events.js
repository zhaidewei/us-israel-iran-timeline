const kv = require('../lib/kv');

const BAD_IDS = new Set([
  'guardian-https://www.theguardian.com/australia-news/2026/mar/01/australia-aged-care-home-support-system-broken',
  'guardian-https://www.theguardian.com/australia-news/2026/mar/01/violent-and-menacing-threats-to-australias-politicians-double-in-two-years-according-to-police-data-ntwnfb'
]);

async function main() {
  const events = await kv.get('events');
  const cleaned = events.filter(e => !BAD_IDS.has(e.id));
  console.log('删除前:', events.length, '条，删除后:', cleaned.length, '条');
  await kv.set('events', cleaned);
  console.log('KV 已更新');
}

main().catch(err => { console.error(err.message); process.exit(1); });
