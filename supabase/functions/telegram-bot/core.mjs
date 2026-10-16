export const HELP = `🤖 Gemini Ai

Savolingizni matn shaklida yuboring. O‘zbekcha, inglizcha yoki boshqa tilda suhbatlashishingiz mumkin.

/new — suhbat xotirasini tozalash
/help — yordam
/privacy — ma’lumotlar haqida

Bu Google’ning rasmiy Telegram boti emas; javoblar Gemini API yordamida yaratiladi. Hozircha matnli xabarlar qo‘llab-quvvatlanadi.`;

export const PRIVACY = `Xabaringiz javob tayyorlash uchun Google Gemini API’ga yuboriladi. So‘nggi suhbatlar Supabase bazasida saqlanadi. /new yoki /forget botning faol suhbat xotirasini o‘chiradi; Telegramdagi xabarlar, zaxira nusxalar va Google saqlash qoidalariga bu buyruq ta’sir qilmaydi. Parol yoki API kalit yubormang.`;

export function splitText(text, limit = 4000) {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Invalid chunk size');
  const chunks = [];
  let part = '';
  for (const ch of text) {
    // Count UTF-16 conservatively and never split an emoji surrogate pair.
    if (part.length + ch.length > limit) { chunks.push(part); part = ''; }
    part += ch;
  }
  if (part) chunks.push(part);
  return chunks;
}

export function trimHistory(history, turns, maxChars) {
  const pairs = [];
  let chars = 0;
  for (let i = history.length - 2; i >= 0; i -= 2) {
    const pair = history.slice(i, i + 2);
    const size = pair.reduce((sum, item) => sum + item.parts.reduce((n, p) => n + (p.text?.length || 0), 0), 0);
    if (pairs.length >= turns || chars + size > maxChars) break;
    pairs.unshift(pair); chars += size;
  }
  return pairs.flat();
}

export function command(text) {
  return text.trim().split(/\s/)[0].split('@')[0].toLowerCase();
}

export function publicError(error) {
  if (error.status === 422) return 'Gemini bu so‘rovga javob qaytarmadi. Savolingizni boshqacha ifodalab ko‘ring.';
  if (error.status === 429) return 'Gemini API kvotasi yoki so‘rov tezligi chegarasiga yetildi. Birozdan keyin qayta urinib ko‘ring; davom etsa, administrator Google loyihasidagi kvotani tekshirishi kerak.';
  if ([400, 401, 403, 404].includes(error.status)) return 'AI sozlamasida muammo bor. Administrator API kaliti, model nomi va modelga kirish huquqini tekshirishi kerak.';
  return 'AI hozir javob bera olmadi. Iltimos, birozdan keyin qayta yuboring.';
}

export function createHandler({ secret, allowedUsers = [], store, ai, telegram, historyTurns = 12, historyCharLimit = 48000, logger = console }) {
  if (!secret) throw new Error('Webhook secret is required');
  return async function handle(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (req.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('Unauthorized', { status: 401 });
    let update;
    try {
      const body = await req.text();
      if (body.length > 262144) return new Response('Too large', { status: 413 });
      update = JSON.parse(body);
    } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
    const msg = update.message;
    if (!msg || msg.chat?.type !== 'private' || msg.from?.is_bot) return new Response('OK');
    if (!Number.isSafeInteger(msg.chat.id) || !Number.isSafeInteger(msg.from?.id)) return new Response('Invalid message', { status: 400 });
    if (allowedUsers.length && !allowedUsers.includes(String(msg.from.id))) return new Response('OK');
    const ctx = { chat: msg.chat.id, update: update.update_id, owner: crypto.randomUUID(), signal: AbortSignal.timeout(90000) };
    let claimed = false;
    try {
      const job = await store.claim(ctx);
      if (job.status === 'done') return new Response('OK');
      if (job.status !== 'claimed') return new Response('Busy', { status: 503, headers: { 'Retry-After': '3' } });
      claimed = true;
      let reply = job.reply;
      if (!reply) {
        let text;
        let nextHistory = job.history || [];
        let clear = false;
        const input = typeof msg.text === 'string' ? msg.text.trim() : '';
        const cmd = command(input);
        if (cmd === '/start' || cmd === '/help') text = HELP;
        else if (cmd === '/privacy') text = PRIVACY;
        else if (cmd === '/new' || cmd === '/forget') {
          text = '🧹 Suhbat xotirasi tozalandi. Yangi savolingizni yuboring.';
          nextHistory = []; clear = true;
        } else if (!input) text = 'Hozircha matnli xabarlarni qabul qilaman. Savolingizni yozib yuboring.';
        else if (input.startsWith('/')) text = 'Buyruq topilmadi. /help orqali buyruqlarni ko‘ring.';
        else {
          await telegram('sendChatAction', { chat_id: ctx.chat, action: 'typing' }, ctx.signal).catch(() => {});
          const history = trimHistory(nextHistory, historyTurns, historyCharLimit);
          try {
            text = await ai([...history, { role: 'user', parts: [{ text: input }] }], ctx.signal);
            nextHistory = trimHistory([...history, { role: 'user', parts: [{ text: input }] }, { role: 'model', parts: [{ text }] }], historyTurns, historyCharLimit);
          } catch (error) {
            // Do not log URLs, provider response bodies, keys or user messages.
            logger.warn('gemini_request_failed', { status: error.status || 0 });
            text = publicError(error);
          }
        }
        reply = splitText(text);
        await store.save(ctx, { reply, next_history: nextHistory, clear });
      }
      for (let i = job.sent || 0; i < reply.length; i++) {
        try {
          await telegram('sendMessage', { chat_id: ctx.chat, text: reply[i], link_preview_options: { is_disabled: true } }, ctx.signal);
        } catch (error) {
          if (error.status === 403) {
            await store.finish(ctx, { discard: true });
            return new Response('OK');
          }
          throw error;
        }
        await store.progress(ctx, { sent: i + 1 });
      }
      await store.finish(ctx, {});
      return new Response('OK');
    } catch (error) {
      logger.warn('webhook_retry_needed', { status: error.status || 0 });
      if (claimed) await store.release({ ...ctx, signal: AbortSignal.timeout(5000) }).catch(() => {});
      // Telegram retries failed webhooks; a persisted reply avoids regenerating it.
      return new Response('Retry later', { status: 503, headers: { 'Retry-After': '3' } });
    }
  };
}
