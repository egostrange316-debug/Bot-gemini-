-- Run once in a dedicated Supabase project using SQL Editor.
-- This is a bootstrap script, not a generated migration file.
begin;

create table public.gemini_bot_sessions (
  chat_id bigint primary key,
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  owner uuid,
  pending_update bigint,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

create table public.gemini_bot_jobs (
  update_id bigint primary key,
  chat_id bigint not null references public.gemini_bot_sessions(chat_id) on delete cascade,
  reply jsonb,
  next_history jsonb,
  clear_history boolean not null default false,
  sent integer not null default 0 check (sent >= 0),
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index gemini_bot_jobs_chat_idx on public.gemini_bot_jobs(chat_id, created_at);

alter table public.gemini_bot_sessions enable row level security;
alter table public.gemini_bot_jobs enable row level security;
revoke all on public.gemini_bot_sessions, public.gemini_bot_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.gemini_bot_sessions, public.gemini_bot_jobs to service_role;

-- SECURITY INVOKER: only service_role may call this RPC or read its tables.
create function public.gemini_bot_state(
  p_action text, p_chat bigint, p_update bigint, p_owner uuid,
  p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  s public.gemini_bot_sessions%rowtype;
  j public.gemini_bot_jobs%rowtype;
begin
  if p_owner is null or p_chat is null or p_update is null then
    raise exception 'missing identity';
  end if;
  if p_action = 'claim' then
    insert into public.gemini_bot_sessions(chat_id) values (p_chat) on conflict do nothing;
  end if;
  select * into s from public.gemini_bot_sessions where chat_id = p_chat for update;
  if not found then raise exception 'unknown session'; end if;
  select * into j from public.gemini_bot_jobs where update_id = p_update;
  if found and j.chat_id <> p_chat then raise exception 'update chat mismatch'; end if;

  if p_action = 'claim' then
    if j.done then return jsonb_build_object('status', 'done'); end if;
    if s.pending_update is not null and s.pending_update <> p_update then
      return jsonb_build_object('status', 'busy');
    end if;
    if s.lease_until > clock_timestamp() then return jsonb_build_object('status', 'busy'); end if;
    insert into public.gemini_bot_jobs(update_id, chat_id) values (p_update, p_chat) on conflict do nothing;
    update public.gemini_bot_sessions set owner = p_owner, pending_update = p_update,
      lease_until = clock_timestamp() + interval '120 seconds', updated_at = now()
      where chat_id = p_chat;
    delete from public.gemini_bot_jobs where chat_id = p_chat and done and created_at < now() - interval '7 days';
    select * into j from public.gemini_bot_jobs where update_id = p_update;
    return jsonb_build_object('status', 'claimed', 'history', s.history, 'reply', j.reply, 'sent', j.sent);
  end if;

  if s.owner is distinct from p_owner or s.pending_update is distinct from p_update
     or s.lease_until is null or s.lease_until <= clock_timestamp() then
    raise exception 'lease lost';
  end if;

  if p_action = 'save' then
    if jsonb_typeof(p_payload->'reply') is distinct from 'array'
       or jsonb_typeof(p_payload->'next_history') is distinct from 'array' then
      raise exception 'invalid reply';
    end if;
    update public.gemini_bot_jobs set reply = p_payload->'reply',
      next_history = p_payload->'next_history', clear_history = coalesce((p_payload->>'clear')::boolean, false)
      where update_id = p_update;
  elsif p_action = 'progress' then
    if (p_payload->>'sent')::integer <> j.sent + 1 or (p_payload->>'sent')::integer > jsonb_array_length(j.reply) then
      raise exception 'invalid delivery progress';
    end if;
    update public.gemini_bot_jobs set sent = (p_payload->>'sent')::integer where update_id = p_update;
  elsif p_action = 'finish' then
    if not coalesce((p_payload->>'discard')::boolean, false) then
      if j.reply is null or j.sent <> jsonb_array_length(j.reply) then raise exception 'reply incomplete'; end if;
      update public.gemini_bot_sessions set history = coalesce(j.next_history, '[]'::jsonb) where chat_id = p_chat;
    end if;
    update public.gemini_bot_jobs set done = true, reply = null, next_history = null where update_id = p_update;
    if j.clear_history then
      update public.gemini_bot_jobs set reply = null, next_history = null where chat_id = p_chat and done;
    end if;
    update public.gemini_bot_sessions set owner = null, pending_update = null, lease_until = null,
      updated_at = now() where chat_id = p_chat;
  elsif p_action = 'release' then
    update public.gemini_bot_sessions set owner = null, lease_until = null where chat_id = p_chat;
  else
    raise exception 'invalid action';
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.gemini_bot_state(text, bigint, bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.gemini_bot_state(text, bigint, bigint, uuid, jsonb) to service_role;
commit;
