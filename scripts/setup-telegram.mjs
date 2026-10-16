const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL;
async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram API ${data.error_code || 'error'}`);
  return data.result;
}
try {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (process.argv.includes('--status')) {
    const info = await call('getWebhookInfo', {});
    console.log(JSON.stringify({ url: info.url, pending_updates: info.pending_update_count, last_error_date: info.last_error_date || null, max_connections: info.max_connections }, null, 2));
  } else {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || '')) throw new Error('Valid TELEGRAM_WEBHOOK_SECRET is required');
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('Use a clean HTTPS WEBHOOK_URL');
    const me = await call('getMe', {});
    await call('setMyName', { name: 'Gemini Ai' });
    await call('setMyDescription', { description: 'Gemini API asosidagi mustaqil AI yordamchi. Matnli savollar, o‘qish, tarjima va dasturlash. Google’ning rasmiy Telegram boti emas.' });
    await call('setMyCommands', { commands: [
      { command: 'start', description: 'Botni boshlash' },
      { command: 'new', description: 'Suhbat xotirasini tozalash' },
      { command: 'help', description: 'Yordam' },
      { command: 'privacy', description: 'Ma’lumotlar haqida' },
    ] });
    await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false });
    console.log(`Webhook ulandi: @${me.username}`);
  }
} catch (error) {
  // Never print fetch errors, since their URLs can include the bot token.
  console.error(error instanceof TypeError ? 'Sozlama yoki tarmoq xatosi.' : error.name === 'TimeoutError' ? 'Telegram javob vaqti tugadi.' : error.message);
  process.exitCode = 1;
}
