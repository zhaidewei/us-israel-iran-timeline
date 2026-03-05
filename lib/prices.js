const fetch = require('node-fetch');

const PRICE_ASSETS = [
  { symbol: 'CL=F',     nameZh: 'WTI原油',  unit: '$/桶',  id: 'oil',  color: '#f97316' },
  { symbol: 'GC=F',     nameZh: '黄金',     unit: '$/盎司', id: 'gold', color: '#eab308' },
  { symbol: 'DX-Y.NYB', nameZh: '美元指数', unit: 'DXY',   id: 'dxy',  color: '#3b82f6' },
  { symbol: 'BTC-USD',  nameZh: '比特币',   unit: '$',     id: 'btc',  color: '#f59e0b' },
];

async function fetchAssetHistory(asset) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?interval=1h&range=7d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?interval=1h&range=7d`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        }
      });
      if (!res.ok) { console.error(`[价格] ${asset.symbol} HTTP ${res.status}`); continue; }
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) continue;

      const timestamps = result.timestamp || [];
      const closes     = result.indicators?.quote?.[0]?.close || [];
      const meta       = result.meta || {};

      const history = timestamps
        .map((t, i) => ({ time: t * 1000, value: closes[i] }))
        .filter(p => p.value != null && !isNaN(p.value))
        .slice(-168);

      if (!history.length) continue;

      const currentPrice = meta.regularMarketPrice ?? history[history.length - 1].value;
      const prevClose    = meta.chartPreviousClose  ?? history[0].value;
      const change       = currentPrice - prevClose;
      const changePct    = prevClose ? (change / prevClose) * 100 : 0;

      return { id: asset.id, symbol: asset.symbol, nameZh: asset.nameZh,
               unit: asset.unit, color: asset.color,
               currentPrice, change, changePct, history };
    } catch (err) {
      console.error(`[价格] ${asset.symbol} 失败:`, err.message);
    }
  }
  return null;
}

/**
 * 从 Yahoo Finance 拉取市场行情，写入 KV。
 * @param {object} kv  lib/kv.js 导出的 { get, set }
 */
async function fetchMarketPrices(kv) {
  console.log('[价格] 获取市场行情...');
  const results = await Promise.all(PRICE_ASSETS.map(fetchAssetHistory));
  const assets  = results.filter(Boolean);
  console.log(`[价格] 成功 ${assets.length}/${PRICE_ASSETS.length} 个资产`);
  if (!assets.length) {
    console.warn('[价格] 无数据，保留缓存');
    return (await kv.get('prices')) || { lastUpdated: null, assets: [] };
  }
  const data = { lastUpdated: new Date().toISOString(), assets };
  await kv.set('prices', data);
  return data;
}

module.exports = { fetchMarketPrices };
