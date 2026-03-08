const fetch = require('node-fetch');

/**
 * 批量翻译为中文，使用 DeepSeek API。texts 中的空字符串保留原值。
 * @param {string[]} texts
 * @param {string} token  DeepSeek API key (DEEPSEEK_API_TOKEN)
 * @returns {Promise<string[]>}
 */
async function translateBatch(texts, token) {
  if (!texts.length || !token) return texts;
  const nonEmpty = texts.map((t, i) => ({ t, i })).filter(x => x.t && x.t.trim());
  if (!nonEmpty.length) return texts;

  // 将多条文本编号后合并为一个请求，减少 API 调用
  const numbered = nonEmpty.map((x, seq) => `${seq + 1}. ${x.t}`).join('\n');
  const prompt = `将以下编号文本翻译为简体中文。只返回对应编号的翻译结果，格式与输入相同（"序号. 译文"），不要解释或添加任何其他内容。\n\n${numbered}`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
      timeout: 30000,
    });

    if (!res.ok) { console.error(`[Translate] DeepSeek HTTP ${res.status}`); return texts; }

    const json = await res.json();
    const reply = json.choices?.[0]?.message?.content ?? '';

    // 解析 "1. 译文" 格式
    const lines = reply.split('\n').filter(l => /^\d+\.\s/.test(l.trim()));
    const out = [...texts];
    lines.forEach(line => {
      const m = line.trim().match(/^(\d+)\.\s+([\s\S]+)/);
      if (!m) return;
      const seq = parseInt(m[1], 10) - 1;
      if (seq >= 0 && seq < nonEmpty.length) {
        out[nonEmpty[seq].i] = m[2].trim();
      }
    });
    return out;
  } catch (err) {
    console.error('[Translate] 翻译失败:', err.message);
    return texts;
  }
}

module.exports = { translateBatch };
