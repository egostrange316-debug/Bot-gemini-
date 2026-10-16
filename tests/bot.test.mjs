import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, splitText, trimHistory } from '../supabase/functions/telegram-bot/core.mjs';
import { makeServices } from '../supabase/functions/telegram-bot/services.mjs';

const secret = 'a'.repeat(64);
function request(text = 'Salom', id = 1, headers = {}) {
  return new Request('https://example.test/bot', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret, ...headers }, body: JSON.stringify({ update_id: id, message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text } }) });
}
function fixture(options = {}) {
  const jobs = new Map(); let history = []; let aiCalls = 0; const sent = [];
  const store = {
    async claim(ctx) {
      let j = jobs.get(ctx.update);
      if (j?.done) return { status: 'done' };
      if (!j) { j = { sent: 0 }; jobs.set(ctx.update, j); }
      return { status: 'claimed', history, ...j };
    },
    async save(ctx, payload) { Object.assign(jobs.get(ctx.update), payload); },
    async progress(ctx, payload) { Object.assign(jobs.get(ctx.update), payload); },
    async finish(ctx, payload) { const j = jobs.get(ctx.update); if (!payload.discard) history = j.next_history; j.done = true; },
    async release() {},
  };
  const telegram = async (method, body) => { if (method === 'sendMessage') sent.push(body.text); };
  const ai = async () => { aiCalls++; return 'Salom!'; };
  const handler = createHandler({ secret, store, telegram, ai, logger: { warn() {} }, ...options });
  return { handler, jobs, sent, store, get history() { return history; }, get aiCalls() { return aiCalls; } };
}
test('webhook rejects a forged request before side effects', async () => {
  const f = fixture();
  assert.equal((await f.handler(request('x', 1, { 'x-telegram-bot-api-secret-token': 'wrong' }))).status, 401);
  assert.equal(f.jobs.size, 0);
});
test('completed redeliveries do not call AI or send again', async () => {
  const f = fixture();
  assert.equal((await f.handler(request())).status, 200);
  assert.equal((await f.handler(request())).status, 200);
  assert.equal(f.aiCalls, 1); assert.equal(f.sent.length, 1); assert.equal(f.history.length, 2);
});
test('/new clears memory and never calls Gemini', async () => {
  const f = fixture(); await f.handler(request()); await f.handler(request('/new', 2));
  assert.deepEqual(f.history, []); assert.equal(f.aiCalls, 1); assert.equal(f.jobs.get(2).clear, true);
});
test('long Unicode answers are reconstructed without broken surrogate pairs', () => {
  const text = 'A😀🇺🇿o‘'.repeat(3000); const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 4000 && chunk.isWellFormed()));
});
test('context trim preserves whole user/model pairs', () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text: 'abc' }] }));
  assert.deepEqual(trimHistory(history, 2, 100), history.slice(-4));
  assert.deepEqual(trimHistory(history, 10, 7), history.slice(-2));
});
test('quota failure produces a useful reply and does not poison memory', async () => {
  const f = fixture({ ai: async () => { throw Object.assign(new Error(), { status: 429 }); } });
  assert.equal((await f.handler(request())).status, 200);
  assert.match(f.sent[0], /kvotasi/); assert.deepEqual(f.history, []);
});
test('delivery failure resumes the cached reply without a second AI charge', async () => {
  let calls = 0;
  const f = fixture({ telegram: async (method) => { if (method === 'sendMessage' && calls++ === 0) throw new Error('network'); } });
  assert.equal((await f.handler(request())).status, 503);
  assert.equal((await f.handler(request())).status, 200);
  assert.equal(f.aiCalls, 1); assert.equal(calls, 2);
});
test('partial delivery resumes from the next saved chunk', async () => {
  let failed = false; const delivered = [];
  const f = fixture({ ai: async () => 'a'.repeat(4000) + 'b', telegram: async (method, body) => {
    if (method !== 'sendMessage') return;
    if (body.text === 'b' && !failed) { failed = true; throw new Error('network'); }
    delivered.push(body.text);
  } });
  assert.equal((await f.handler(request())).status, 503);
  assert.equal((await f.handler(request())).status, 200);
  assert.deepEqual(delivered, ['a'.repeat(4000), 'b']);
});
test('a busy session is retried, not acknowledged and lost', async () => {
  const f = fixture({ store: { claim: async () => ({ status: 'busy' }) } });
  assert.equal((await f.handler(request())).status, 503); assert.equal(f.aiCalls, 0);
});
test('optional owner-only mode blocks unlisted users', async () => {
  const f = fixture({ allowedUsers: ['999'] });
  assert.equal((await f.handler(request())).status, 200); assert.equal(f.jobs.size, 0);
});
test('unsupported attachments receive help', async () => {
  const f = fixture(); await f.handler(request('')); assert.match(f.sent[0], /matnli/); assert.equal(f.aiCalls, 0);
});
test('Gemini request uses header authentication and excludes internal thoughts', async () => {
  const config = { model: 'test-model', geminiKey: 'test-key', maxTokens: 4096 };
  const { ai } = makeServices(config, async (url, options) => {
    assert.ok(!url.includes('test-key')); assert.equal(options.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(options.body); assert.equal(body.contents[0].role, 'user');
    assert.equal(body.safetySettings, undefined);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }, { text: 'visible' }] } }] });
  });
  assert.equal(await ai([{ role: 'user', parts: [{ text: 'Hi' }] }], new AbortController().signal), 'visible');
});
test('blocked model response is not sent as an empty success', async () => {
  const { ai } = makeServices({ model: 'test' }, async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(ai([], new AbortController().signal), error => error.status === 422);
});
test('a Telegram 403 ends retrying for blocked bots', async () => {
  const f = fixture({ telegram: async method => { if (method === 'sendMessage') throw Object.assign(new Error(), { status: 403 }); } });
  assert.equal((await f.handler(request())).status, 200); assert.equal(f.jobs.get(1).done, true);
});
