export class ServiceError extends Error {
  constructor(service, status) { super(`${service} request failed`); this.status = status; }
}

async function post(url, body, headers, parentSignal, timeout, fetcher) {
  const response = await fetcher(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.any([parentSignal, AbortSignal.timeout(timeout)]),
  });
  if (!response.ok) throw new ServiceError('upstream', response.status);
  return await response.json();
}

export function makeServices(config, fetcher = fetch) {
  const telegram = async (method, body, signal) => {
    const result = await post(`https://api.telegram.org/bot${config.botToken}/${method}`, body, {}, signal, 10000, fetcher);
    if (!result.ok) throw new ServiceError('telegram', result.error_code || 502);
    return result.result;
  };
  const ai = async (contents, signal) => {
    const result = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
      systemInstruction: { parts: [{ text: 'You are Gemini Ai, an independent Telegram assistant powered by Gemini. Respond in the user’s language; default to Uzbek. Be helpful, clear and honest. Answer general knowledge, writing, language, study and programming questions. Do not claim to browse, execute code or perform actions you cannot do. Never claim to be the official Google Telegram bot. Use readable plain text.' }] },
      contents,
      generationConfig: { maxOutputTokens: config.maxTokens },
    }, { 'x-goog-api-key': config.geminiKey }, signal, 40000, fetcher);
    const candidate = result.candidates?.[0];
    if (result.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(candidate?.finishReason)) {
      throw new ServiceError('gemini_blocked', 422);
    }
    let text = candidate?.content?.parts?.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('')?.trim();
    if (!text) throw new ServiceError('gemini_empty', 502);
    if (candidate.finishReason === 'MAX_TOKENS') text += '\n\n[Javob uzunligi chegarasiga yetdi. Davomini so‘rashingiz mumkin.]';
    return text;
  };
  const rpc = async (action, ctx, payload = {}) => post(`${config.supabaseUrl}/rest/v1/rpc/gemini_bot_state`, {
    p_action: action, p_chat: ctx.chat, p_update: ctx.update, p_owner: ctx.owner, p_payload: payload,
  }, { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` }, ctx.signal, 5000, fetcher);
  const store = Object.fromEntries(['claim', 'save', 'progress', 'finish', 'release'].map(action => [action, (ctx, payload) => rpc(action, ctx, payload)]));
  return { telegram, ai, store };
}
