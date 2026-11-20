-- Минимальная заглушка Supabase для тестов: роли, auth, storage, realtime.
-- И «боевое» состояние до настройки: таблица rooms и старые открытые правила.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated;

create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
insert into auth.users values ('0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', 'admin@memology.test');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id bigserial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated;

create publication supabase_realtime;

-- Как в Supabase: права на всё в public, ограничивает только RLS
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- Состояние до настройки
create table public.rooms (code text primary key, data jsonb not null, created_at timestamptz default now());
create table public.situations (id bigserial primary key, text text not null, active boolean default true, created_at timestamptz default now());
create table public.memes (id bigserial primary key, title text not null, image_url text not null, active boolean default true, created_at timestamptz default now());
create table public.suggestions (id bigserial primary key, type text not null, text text not null, player text, room text, handled boolean default false, created_at timestamptz default now());
alter table public.situations enable row level security;
alter table public.memes enable row level security;
alter table public.suggestions enable row level security;
create policy "public read situations" on public.situations for select using (true);
create policy "public delete situations" on public.situations for delete using (true);
create policy "public read memes" on public.memes for select using (true);
create policy "public delete memes" on public.memes for delete using (true);
create policy "public insert suggestions" on public.suggestions for insert with check (true);
create policy "public read suggestions" on public.suggestions for select using (true);
create policy "public upload memes storage" on storage.objects for insert with check (bucket_id = 'memes');

insert into public.memes (title, image_url, active)
select 'Мем ' || i, 'https://img.test/m' || i || '.svg', true from generate_series(1, 40) i;
insert into public.situations (text) select 'Ситуация номер ' || i from generate_series(1, 30) i;
