// SQL для Supabase: таблицы контента и закрытый доступ (только админ).
// Выполняется вручную в Supabase → SQL Editor. Повторный запуск безопасен.

export const SCHEMA_SQL = `-- Таблицы контента
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

-- Хранилище картинок мемов
insert into storage.buckets (id, name, public)
values ('memes', 'memes', true)
on conflict do nothing;
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function securitySQL(userId) {
  if (!UUID.test(userId || '')) throw new Error('некорректный id пользователя');
  return `-- Memology: менять контент может только админ
-- 1. Список админов и проверка «я админ?»
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
grant execute on function public.is_admin() to anon, authenticated;

insert into public.admins (user_id) values ('${userId}') on conflict do nothing;

-- 2. Убрать старые правила, открывавшие запись всем
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

-- 3. Игрокам: читать активные мемы и ситуации, отправлять предложения
create policy "players read active memes" on public.memes for select using (active);
create policy "players read active situations" on public.situations for select using (active);
create policy "players send suggestions" on public.suggestions for insert with check (true);
create policy "players read meme files" on storage.objects for select using (bucket_id = 'memes');

-- 4. Админу: всё остальное
create policy "admin manages memes" on public.memes for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages situations" on public.situations for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages suggestions" on public.suggestions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin uploads meme files" on storage.objects for insert
  with check (bucket_id = 'memes' and public.is_admin());
create policy "admin changes meme files" on storage.objects for update
  using (bucket_id = 'memes' and public.is_admin());
create policy "admin deletes meme files" on storage.objects for delete
  using (bucket_id = 'memes' and public.is_admin());
`;
}

export const fullSQL = userId => `${SCHEMA_SQL}\n${securitySQL(userId)}\n-- Для самой игры нужны ещё таблица rooms и функции patch_room / play_card:\n-- их описание — в README.md репозитория.\n`;
