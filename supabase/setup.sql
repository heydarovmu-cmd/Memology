-- ═══════════════════════════════════════════════════════════════════
-- Memology — настройка базы Supabase
-- Выполнять целиком в Supabase → SQL Editor. Повторный запуск безопасен.
--
-- Что делает:
--   1. таблицы контента (мемы, ситуации, предложения) и хранилище картинок;
--   2. админы: смотреть и менять контент может только админ;
--   3. игра: раздача карт и все ходы — на сервере. Устройство игрока
--      получает только свою руку; колода, чужие руки, каталог и авторы
--      мемов до голосования хранятся в room_secrets, куда доступа нет.
--
-- __ADMIN_USER_ID__ админка подставляет сама (id вошедшего пользователя).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Контент ─────────────────────────────────────────────────────
create table if not exists public.situations (
  id bigserial primary key,
  text text not null,
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.memes (
  id bigserial primary key,
  title text not null,
  image_url text not null,
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.suggestions (
  id bigserial primary key,
  type text not null,
  text text not null,
  player text,
  room text,
  handled boolean default false,
  created_at timestamptz default now()
);

insert into storage.buckets (id, name, public)
values ('memes', 'memes', true)
on conflict do nothing;

-- ── 2. Админы ──────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Админ добавляется, только если такой пользователь есть в Supabase Auth
insert into public.admins (user_id)
select id from auth.users where id::text = '__ADMIN_USER_ID__'
on conflict do nothing;

-- ── 3. Правила доступа к контенту ──────────────────────────────────
-- Старые правила (в том числе открывавшие чтение и запись всем) удаляются
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('memes', 'situations', 'suggestions') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
  for r in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and (coalesce(qual, '') || coalesce(with_check, '')) like '%memes%' loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

alter table public.memes enable row level security;
alter table public.situations enable row level security;
alter table public.suggestions enable row level security;

-- Игроки: только отправить предложение. Мемы и ситуации им раздаёт игра.
create policy "players send suggestions" on public.suggestions for insert with check (true);

-- Админ: всё
create policy "admin manages memes" on public.memes for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages situations" on public.situations for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages suggestions" on public.suggestions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin reads meme files" on storage.objects for select
  using (bucket_id = 'memes' and public.is_admin());
create policy "admin uploads meme files" on storage.objects for insert
  with check (bucket_id = 'memes' and public.is_admin());
create policy "admin changes meme files" on storage.objects for update
  using (bucket_id = 'memes' and public.is_admin());
create policy "admin deletes meme files" on storage.objects for delete
  using (bucket_id = 'memes' and public.is_admin());

-- ── 4. Игра ────────────────────────────────────────────────────────
-- rooms.data — открытое состояние партии (его видят все и получают через realtime).
-- room_secrets — то, что игрокам видеть нельзя.
do $$
begin
  if to_regclass('public.rooms') is null then
    create table public.rooms (
      code text primary key,
      data jsonb not null,
      created_at timestamptz default now()
    );
  end if;
end $$;

-- Комнату игроки только читают; менять её могут лишь функции mg_* ниже
alter table public.rooms enable row level security;
do $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'rooms' loop
    execute format('drop policy %I on public.rooms', r.policyname);
  end loop;
  begin
    alter publication supabase_realtime add table public.rooms;
  exception when others then null;   -- уже добавлена
  end;
end $$;
create policy "players read rooms" on public.rooms for select using (true);
revoke insert, update, delete, truncate on public.rooms from anon, authenticated;

-- Функции прошлой версии писали в комнату что угодно — убрать
drop function if exists public.patch_room(text, jsonb);
drop function if exists public.play_card(text, text, int);
do $$
begin
  if to_regprocedure('public.cleanup_old_rooms()') is not null then
    revoke execute on function public.cleanup_old_rooms() from public, anon, authenticated;
  end if;
end $$;

create table if not exists public.room_secrets (
  code text primary key,
  tokens jsonb not null default '{}'::jsonb,   -- { место: секрет устройства }
  deck jsonb not null default '[]'::jsonb,     -- колода
  hands jsonb not null default '{}'::jsonb,    -- { место: [карты] }
  sits jsonb not null default '[]'::jsonb,     -- две ситуации на выбор читающему
  used jsonb not null default '[]'::jsonb,     -- уже выпадавшие ситуации
  plays jsonb not null default '{}'::jsonb,    -- { место: сыгранный мем } в этом раунде
  owners jsonb not null default '[]'::jsonb,   -- чей мем на каждой позиции стола
  created_at timestamptz not null default now()
);
alter table public.room_secrets enable row level security;
revoke all on public.room_secrets from anon, authenticated;

-- Версия серверной части: админка проверяет, что SQL выполнен
create or replace function public.mg_version()
returns int language sql immutable as $$ select 2 $$;

-- ── Вспомогательные (недоступны игрокам напрямую) ──

create or replace function public.mg_codegen()
returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 4);
$$;

-- Игроки в партии: сели, не ушли и (в лобби) или (получили карты при старте)
create or replace function public.mg_active(d jsonb)
returns int[] language sql immutable as $$
  select coalesce(array_agg((p->>'idx')::int order by (p->>'idx')::int), '{}')
  from jsonb_each(coalesce(d->'players', '{}'::jsonb)) as e(k, p)
  where jsonb_typeof(p) = 'object'
    and not coalesce((p->>'left')::boolean, false)
    and (d->>'phase' = 'lobby' or coalesce((p->>'playing')::boolean, false));
$$;

create or replace function public.mg_next_after(d jsonb, i int)
returns int language sql immutable as $$
  select coalesce(
    (select min(a) from unnest(public.mg_active(d)) a where a > i),
    (select min(a) from unnest(public.mg_active(d)) a));
$$;

create or replace function public.mg_last_round(d jsonb)
returns boolean language sql immutable as $$
  select (d->>'rounds')::int <> 9999 and coalesce((d->>'currentRound')::int, 1) >= (d->>'rounds')::int;
$$;

-- Сколько активных игроков делят первое место
create or replace function public.mg_leaders(d jsonb)
returns int language sql immutable as $$
  with s as (
    select coalesce((d->'players'->(a::text)->>'score')::int, 0) as score
    from unnest(public.mg_active(d)) a
  )
  select count(*)::int from s where score = (select max(score) from s);
$$;

create or replace function public.mg_pick_sits(used jsonb)
returns jsonb language plpgsql volatile set search_path = public as $$
declare v jsonb;
begin
  select jsonb_agg(text) into v from (
    select text from situations where active and not (coalesce(used, '[]'::jsonb) ? text)
    order by random() limit 2) t;
  if coalesce(jsonb_array_length(v), 0) < 2 then
    select jsonb_agg(text) into v from (select text from situations where active order by random() limit 2) t;
  end if;
  return coalesce(v, '[]'::jsonb);
end $$;

create or replace function public.mg_check_name(p_name text, p_token text)
returns void language plpgsql immutable as $$
begin
  if coalesce(length(trim(p_name)), 0) = 0 or length(trim(p_name)) > 20 then raise exception 'bad_name'; end if;
  if coalesce(length(p_token), 0) < 8 or length(p_token) > 64 then raise exception 'bad_token'; end if;
end $$;

-- Место игрока по секрету его устройства
create or replace function public.mg_seat(p_code text, p_token text)
returns int language sql stable set search_path = public as $$
  select (t.k)::int from room_secrets s, jsonb_each_text(s.tokens) t(k, v)
  where s.code = p_code and t.v = p_token limit 1;
$$;

-- Загрузить и заблокировать комнату; ошибка, если её нет
create or replace function public.mg_lock(p_code text)
returns jsonb language plpgsql volatile set search_path = public as $$
declare d jsonb;
begin
  select data into d from rooms where code = p_code for update;
  if d is null then raise exception 'room_not_found'; end if;
  perform 1 from room_secrets where code = p_code for update;
  if not found then raise exception 'room_outdated'; end if;
  return d;
end $$;

-- Новый раунд (или конец игры). p_skip — раунд пропущен, потому что ушёл читающий.
create or replace function public.mg_advance(p_code text, p_skip boolean)
returns void language plpgsql volatile set search_path = public as $$
declare
  d jsonb; s room_secrets; act int[]; v_reader int; v_sits jsonb; v_last boolean;
begin
  select data into d from rooms where code = p_code;
  select * into s from room_secrets where code = p_code;
  act := mg_active(d);
  v_last := mg_last_round(d);
  if cardinality(act) < 3 then
    update rooms set data = d || '{"phase":"end","endReason":"players"}'::jsonb where code = p_code;
    return;
  end if;
  if p_skip and v_last and mg_leaders(d) <= 1 then
    update rooms set data = d || '{"phase":"end"}'::jsonb where code = p_code;
    return;
  end if;
  v_reader := mg_next_after(d, (d->>'readerIdx')::int);
  if exists (select 1 from unnest(act) a
             where a <> v_reader and coalesce(jsonb_array_length(s.hands->(a::text)), 0) = 0) then
    update rooms set data = d || '{"phase":"end","endReason":"cards"}'::jsonb where code = p_code;
    return;
  end if;
  v_sits := mg_pick_sits(s.used);
  update room_secrets set sits = v_sits, used = used || v_sits, plays = '{}', owners = '[]' where code = p_code;
  update rooms set data = d || jsonb_build_object(
    'phase', 'reader', 'currentRound', coalesce((d->>'currentRound')::int, 1) + 1, 'readerIdx', v_reader,
    'situation', '', 'submitted', '{}'::jsonb, 'tableCards', '[]'::jsonb, 'winnerIdx', -1,
    'tiebreak', p_skip and v_last)
  where code = p_code;
end $$;

-- Автоматические переходы после хода или ухода игрока
create or replace function public.mg_settle(p_code text)
returns void language plpgsql volatile set search_path = public as $$
declare
  d jsonb; s room_secrets; act int[]; pickers int[]; v_owners jsonb; v_table jsonb;
begin
  select data into d from rooms where code = p_code;
  select * into s from room_secrets where code = p_code;
  if d->>'phase' in ('lobby', 'end') then return; end if;
  act := mg_active(d);
  if cardinality(act) < 3 then
    update rooms set data = d || '{"phase":"end","endReason":"players"}'::jsonb where code = p_code;
    return;
  end if;
  if d->>'phase' in ('reader', 'picking', 'judging') and not ((d->>'readerIdx')::int = any(act)) then
    perform mg_advance(p_code, true);
    return;
  end if;
  if d->>'phase' = 'picking' then
    pickers := array(select a from unnest(act) a where a <> (d->>'readerIdx')::int);
    if cardinality(pickers) > 0 and not exists (select 1 from unnest(pickers) a where not (s.plays ? (a::text))) then
      -- Все сдали: мемы на стол в случайном порядке, авторы — только в секретах
      select jsonb_agg(owner order by rn), jsonb_agg(card order by rn) into v_owners, v_table
      from (select key::int as owner, value as card, row_number() over (order by random()) as rn
            from jsonb_each(s.plays) where key::int = any(pickers)) t;
      update room_secrets set owners = v_owners where code = p_code;
      update rooms set data = d || jsonb_build_object('phase', 'judging', 'tableCards', v_table) where code = p_code;
    end if;
  end if;
end $$;

-- ── Ходы (их вызывает игра) ──

create or replace function public.mg_create(p_name text, p_token text, p_rounds int, p_max int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_code text; v_data jsonb; i int := 0;
begin
  perform mg_check_name(p_name, p_token);
  if p_max is null or p_max not between 3 and 10 then raise exception 'bad_players'; end if;
  if p_rounds is null or p_rounds < 1 then raise exception 'bad_rounds'; end if;
  delete from room_secrets s
  where s.created_at < now() - interval '2 days' or not exists (select 1 from rooms r where r.code = s.code);
  loop
    v_code := mg_codegen();
    exit when not exists (select 1 from rooms where code = v_code)
          and not exists (select 1 from room_secrets where code = v_code);
    i := i + 1;
    if i > 50 then raise exception 'no_codes'; end if;
  end loop;
  v_data := jsonb_build_object(
    'code', v_code, 'hostName', trim(p_name), 'rounds', p_rounds, 'maxPlayers', p_max,
    'phase', 'lobby', 'hostIdx', 0, 'currentRound', 1, 'readerIdx', 0,
    'players', jsonb_build_object('0', jsonb_build_object('idx', 0, 'name', trim(p_name), 'score', 0)),
    'playerCount', 1, 'situation', '', 'submitted', '{}'::jsonb, 'tableCards', '[]'::jsonb,
    'winnerIdx', -1, 'deckCount', 0);
  insert into rooms (code, data) values (v_code, v_data);
  insert into room_secrets (code, tokens) values (v_code, jsonb_build_object('0', p_token));
  return v_data;
end $$;

create or replace function public.mg_join(p_code text, p_name text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; v_code text := upper(trim(p_code)); v_idx int; v_old int; v_present int;
begin
  perform mg_check_name(p_name, p_token);
  d := mg_lock(v_code);
  v_old := mg_seat(v_code, p_token);
  -- То же устройство уже за столом — просто вернуть его место
  if v_old is not null and not coalesce((d->'players'->(v_old::text)->>'left')::boolean, false) then
    return jsonb_build_object('idx', v_old, 'room', d);
  end if;
  if d->>'phase' <> 'lobby' then raise exception 'game_started'; end if;
  v_present := cardinality(mg_active(d));
  if v_present >= coalesce((d->>'maxPlayers')::int, 10) then raise exception 'room_full'; end if;
  select min(i) into v_idx from generate_series(0, 9) i
  where jsonb_typeof(d->'players'->(i::text)) is distinct from 'object'
     or coalesce((d->'players'->(i::text)->>'left')::boolean, false);
  if v_idx is null then raise exception 'room_full'; end if;
  d := jsonb_set(d, array['players', v_idx::text], jsonb_build_object('idx', v_idx, 'name', trim(p_name), 'score', 0));
  d := jsonb_set(d, '{playerCount}', to_jsonb(v_present + 1));
  update room_secrets
  set tokens = (case when v_old is null then tokens else tokens - v_old::text end) || jsonb_build_object(v_idx::text, p_token)
  where code = v_code;
  update rooms set data = d where code = v_code;
  return jsonb_build_object('idx', v_idx, 'room', d);
end $$;

-- То, что видит только этот игрок: его карты и (читающему) две ситуации
create or replace function public.mg_view(p_code text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d jsonb; s room_secrets; v_idx int;
begin
  select data into d from rooms where code = upper(p_code);
  select * into s from room_secrets where code = upper(p_code);
  if d is null or s is null then raise exception 'room_not_found'; end if;
  v_idx := mg_seat(s.code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  return jsonb_build_object(
    'idx', v_idx,
    'round', d->'currentRound',
    'hand', coalesce(s.hands->(v_idx::text), '[]'::jsonb),
    'played', s.plays->(v_idx::text),
    'sits', case when d->>'phase' = 'reader' and (d->>'readerIdx')::int = v_idx then s.sits else '[]'::jsonb end);
end $$;

create or replace function public.mg_start(p_code text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  d jsonb; v_idx int; act int[]; n int; v_deck jsonb; v_total int; v_hands jsonb := '{}'; v_sits jsonb; i int; a int;
begin
  d := mg_lock(p_code);
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  if v_idx <> coalesce((d->>'hostIdx')::int, 0) then raise exception 'not_host'; end if;
  if d->>'phase' <> 'lobby' then raise exception 'game_started'; end if;
  act := mg_active(d);
  n := cardinality(act);
  if n < 3 then raise exception 'few_players'; end if;
  select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'image_url', image_url) order by random())
  into v_deck from memes where active and coalesce(image_url, '') <> '';
  v_total := coalesce(jsonb_array_length(v_deck), 0);
  if v_total < n * 5 then raise exception 'few_memes:%:%', n * 5, v_total; end if;
  if (select count(*) from situations where active) < 2 then raise exception 'few_situations'; end if;
  i := 0;
  foreach a in array act loop
    v_hands := v_hands || jsonb_build_object(a::text,
      (select jsonb_agg(e order by o) from jsonb_array_elements(v_deck) with ordinality t(e, o) where o > i and o <= i + 5));
    d := jsonb_set(d, array['players', a::text, 'playing'], 'true');
    i := i + 5;
  end loop;
  v_deck := coalesce((select jsonb_agg(e order by o) from jsonb_array_elements(v_deck) with ordinality t(e, o) where o > i), '[]');
  v_sits := mg_pick_sits('[]');
  update room_secrets
  set deck = v_deck, hands = v_hands, sits = v_sits, used = v_sits, plays = '{}', owners = '[]'
  where code = p_code;
  d := d || jsonb_build_object(
    'phase', 'reader', 'currentRound', 1, 'readerIdx', act[1], 'situation', '',
    'submitted', '{}'::jsonb, 'tableCards', '[]'::jsonb, 'winnerIdx', -1, 'tiebreak', false,
    'deckCount', jsonb_array_length(v_deck), 'playerCount', n);
  update rooms set data = d where code = p_code;
  return d;
end $$;

create or replace function public.mg_choose(p_code text, p_token text, p_half int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; v_idx int; v_sit text;
begin
  d := mg_lock(p_code);
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  if d->>'phase' <> 'reader' then raise exception 'wrong_phase'; end if;
  if v_idx <> (d->>'readerIdx')::int then raise exception 'not_reader'; end if;
  select sits->>p_half into v_sit from room_secrets where code = p_code;
  if v_sit is null then raise exception 'bad_choice'; end if;
  update room_secrets set plays = '{}', owners = '[]' where code = p_code;
  d := d || jsonb_build_object('phase', 'picking', 'situation', v_sit, 'submitted', '{}'::jsonb);
  update rooms set data = d where code = p_code;
  perform mg_settle(p_code);
  return (select data from rooms where code = p_code);
end $$;

create or replace function public.mg_play(p_code text, p_token text, p_index int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; s room_secrets; v_idx int; v_hand jsonb; v_card jsonb; v_deck jsonb;
begin
  d := mg_lock(p_code);
  select * into s from room_secrets where code = p_code;
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  if d->>'phase' <> 'picking' then raise exception 'wrong_phase'; end if;
  if v_idx = (d->>'readerIdx')::int then raise exception 'is_reader'; end if;
  if not (v_idx = any(mg_active(d))) then raise exception 'not_playing'; end if;
  if s.plays ? (v_idx::text) then raise exception 'already_played'; end if;
  v_hand := coalesce(s.hands->(v_idx::text), '[]');
  if p_index is null or p_index < 0 or p_index >= jsonb_array_length(v_hand) then raise exception 'bad_card'; end if;
  v_card := v_hand->p_index;
  v_deck := s.deck;
  if jsonb_array_length(v_deck) > 0 then
    v_hand := jsonb_set(v_hand, array[p_index::text], v_deck->0);   -- замена на то же место
    v_deck := v_deck - 0;
  else
    v_hand := v_hand - p_index;
  end if;
  update room_secrets
  set hands = jsonb_set(hands, array[v_idx::text], v_hand), deck = v_deck,
      plays = plays || jsonb_build_object(v_idx::text, v_card)
  where code = p_code;
  d := jsonb_set(d, array['submitted', v_idx::text], 'true');
  d := jsonb_set(d, '{deckCount}', to_jsonb(jsonb_array_length(v_deck)));
  update rooms set data = d where code = p_code;
  perform mg_settle(p_code);
  return (select data from rooms where code = p_code);
end $$;

create or replace function public.mg_judge(p_code text, p_token text, p_pos int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; s room_secrets; v_idx int; v_owner int; v_score int; v_table jsonb; v_last boolean; v_tie boolean;
begin
  d := mg_lock(p_code);
  select * into s from room_secrets where code = p_code;
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  if d->>'phase' <> 'judging' then raise exception 'wrong_phase'; end if;
  if v_idx <> (d->>'readerIdx')::int then raise exception 'not_reader'; end if;
  v_owner := (s.owners->>p_pos)::int;
  if v_owner is null then raise exception 'bad_card'; end if;
  v_score := coalesce((d->'players'->(v_owner::text)->>'score')::int, 0) + 1;
  d := jsonb_set(d, array['players', v_owner::text, 'score'], to_jsonb(v_score));
  -- После голосования авторы раскрываются
  select jsonb_agg(c || jsonb_build_object('playerIdx', (s.owners->>((o - 1)::int))::int) order by o)
  into v_table from jsonb_array_elements(d->'tableCards') with ordinality t(c, o);
  v_last := mg_last_round(d);
  v_tie := mg_leaders(d) > 1;
  d := d || jsonb_build_object(
    'winnerIdx', v_owner, 'tableCards', coalesce(v_table, '[]'::jsonb),
    'tiebreak', v_last and v_tie,
    'phase', case when v_last and not v_tie then 'end' else 'result' end);
  update rooms set data = d where code = p_code;
  return d;
end $$;

create or replace function public.mg_next(p_code text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; v_idx int;
begin
  d := mg_lock(p_code);
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null then raise exception 'not_in_room'; end if;
  if v_idx <> coalesce((d->>'hostIdx')::int, 0) then raise exception 'not_host'; end if;
  if d->>'phase' <> 'result' then raise exception 'wrong_phase'; end if;
  perform mg_advance(p_code, false);
  return (select data from rooms where code = p_code);
end $$;

create or replace function public.mg_leave(p_code text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d jsonb; v_idx int; rest int[];
begin
  d := mg_lock(p_code);
  v_idx := mg_seat(p_code, p_token);
  if v_idx is null or d->>'phase' = 'end' then return d; end if;
  if jsonb_typeof(d->'players'->(v_idx::text)) <> 'object' then return d; end if;
  d := jsonb_set(d, array['players', v_idx::text, 'left'], 'true');
  rest := mg_active(d);
  if d->>'phase' = 'lobby' then d := jsonb_set(d, '{playerCount}', to_jsonb(cardinality(rest))); end if;
  if coalesce((d->>'hostIdx')::int, 0) = v_idx and cardinality(rest) > 0 then
    d := jsonb_set(d, '{hostIdx}', to_jsonb(mg_next_after(d, v_idx)));
  end if;
  update rooms set data = d where code = p_code;
  perform mg_settle(p_code);
  return (select data from rooms where code = p_code);
end $$;

-- Игрокам доступны только ходы; вспомогательные функции и секреты — нет
revoke execute on function
  public.mg_codegen(), public.mg_active(jsonb), public.mg_next_after(jsonb, int),
  public.mg_last_round(jsonb), public.mg_leaders(jsonb), public.mg_pick_sits(jsonb),
  public.mg_check_name(text, text), public.mg_seat(text, text), public.mg_lock(text),
  public.mg_advance(text, boolean), public.mg_settle(text)
from public, anon, authenticated;

grant execute on function
  public.mg_version(), public.is_admin(),
  public.mg_create(text, text, int, int), public.mg_join(text, text, text), public.mg_view(text, text),
  public.mg_start(text, text), public.mg_choose(text, text, int), public.mg_play(text, text, int),
  public.mg_judge(text, text, int), public.mg_next(text, text), public.mg_leave(text, text)
to anon, authenticated;
