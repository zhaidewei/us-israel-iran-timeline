const fetch = require('node-fetch');

function deepLEndpoint(token) {
  return token?.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
}

/**
 * 批量翻译为中文。texts 中的空字符串保留原值。
 * @param {string[]} texts
 * @param {string} token  DeepL API key
 * @returns {Promise<string[]>}
 */
async function translateBatch(texts, token) {
  if (!texts.length || !token) return texts;
  const nonEmpty = texts.map((t, i) => ({ t, i })).filter(x => x.t && x.t.trim());
  if (!nonEmpty.length) return texts;
  try {
    const res = await fetch(deepLEndpoint(token), {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: nonEmpty.map(x => x.t), target_lang: 'ZH' }),
      timeout: 15000
    });
    if (!res.ok) { console.error(`[DeepL] HTTP ${res.status}`); return texts; }
    const json = await res.json();
    const out = [...texts];
    json.translations.forEach((tr, idx) => { out[nonEmpty[idx].i] = tr.text; });
    return out;
  } catch (err) {
    console.error('[DeepL] 翻译失败:', err.message);
    return texts;
  }
}

module.exports = { translateBatch };
