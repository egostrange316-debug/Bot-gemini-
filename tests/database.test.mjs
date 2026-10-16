import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL state machine and access control', async t => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../db/setup.sql', import.meta.url), 'utf8'));
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const rpc = async (action, update = 1, owner = a, payload = {}, chat = 42) => {
      const result = await db.query('select public.gemini_bot_state($1, $2, $3, $4, $5::jsonb) as value', [action, chat, update, owner, JSON.stringify(payload)]);
      return result.rows[0].value;
    };
    await t.test('anonymous and signed-in clients cannot read or call the RPC', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(db.query('select * from public.gemini_bot_sessions'), /permission denied/);
        await assert.rejects(rpc('claim'), /permission denied/);
        await db.exec('reset role');
      }
      const { rows } = await db.query("select relrowsecurity from pg_class where relname in ('gemini_bot_sessions', 'gemini_bot_jobs')");
      assert.ok(rows.every(row => row.relrowsecurity));
    });
    await db.exec('set role service_role');
    await t.test('a claim prevents duplicate and concurrent work on a chat', async () => {
      assert.equal((await rpc('claim')).status, 'claimed');
      assert.equal((await rpc('claim', 1, b)).status, 'busy');
      assert.equal((await rpc('claim', 2, b)).status, 'busy');
      assert.equal((await rpc('claim', 3, b, {}, 99)).status, 'claimed');
      await assert.rejects(rpc('save', 1, b, { reply: [], next_history: [] }), /lease lost/);
    });
    const history = [{ role: 'user', parts: [{ text: 'Salom' }] }, { role: 'model', parts: [{ text: 'Salom!' }] }];
    await t.test('saved replies survive release and retry, with delivery checkpoints', async () => {
      await rpc('save', 1, a, { reply: ['first', 'second'], next_history: history });
      await rpc('progress', 1, a, { sent: 1 });
      await rpc('release');
      const recovered = await rpc('claim', 1, b);
      assert.equal(recovered.sent, 1); assert.deepEqual(recovered.reply, ['first', 'second']);
      await assert.rejects(rpc('finish', 1, b), /reply incomplete/);
      await rpc('progress', 1, b, { sent: 2 }); await rpc('finish', 1, b);
      assert.equal((await rpc('claim')).status, 'done');
      const { rows } = await db.query('select reply, next_history from public.gemini_bot_jobs where update_id = 1');
      assert.deepEqual(rows[0], { reply: null, next_history: null });
    });
    await t.test('a new turn sees committed history and reset removes it', async () => {
      const job = await rpc('claim', 2); assert.deepEqual(job.history, history);
      await rpc('save', 2, a, { reply: ['reset'], next_history: [], clear: true });
      await rpc('progress', 2, a, { sent: 1 }); await rpc('finish', 2);
      const { rows } = await db.query('select history from public.gemini_bot_sessions where chat_id = 42');
      assert.deepEqual(rows[0].history, []);
    });
    await t.test('expired lease can be reclaimed but stale owner cannot write', async () => {
      await db.exec("update public.gemini_bot_sessions set lease_until = now() - interval '1 second' where chat_id = 99");
      assert.equal((await rpc('claim', 3, a, {}, 99)).status, 'claimed');
      await assert.rejects(rpc('save', 3, b, { reply: [], next_history: [] }, 99), /lease lost/);
    });
  } finally { await db.close(); }
});
