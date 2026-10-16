import { createHandler } from './core.mjs';
import { makeServices } from './services.mjs';

const required = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing environment setting: ${name}`);
  return value;
};
const integer = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number(Deno.env.get(name) || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid setting: ${name}`);
  return value;
};
const secret = required('TELEGRAM_WEBHOOK_SECRET');
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Webhook secret must contain 32–256 safe characters');
const services = makeServices({
  botToken: required('TELEGRAM_BOT_TOKEN'),
  geminiKey: required('GEMINI_API_KEY'),
  model: Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite',
  maxTokens: integer('MAX_OUTPUT_TOKENS', 4096, 256, 16384),
  supabaseUrl: required('SUPABASE_URL').replace(/\/$/, ''),
  serviceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
});
Deno.serve(createHandler({
  ...services, secret,
  allowedUsers: (Deno.env.get('ALLOWED_USER_IDS') || '').split(',').map(x => x.trim()).filter(Boolean),
  historyTurns: integer('HISTORY_TURNS', 12, 1, 100),
  historyCharLimit: integer('HISTORY_CHAR_LIMIT', 48000, 1000, 500000),
}));
