-- Palabra por palabra: база данных.
-- Вставьте весь файл в Supabase → SQL Editor → New query и нажмите Run.
-- Скрипт можно запускать повторно: он ничего не удаляет.

create table if not exists public.chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null,
  paragraphs  jsonb not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.words (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  word           text not null,
  level          smallint not null default 5 check (level between 1 and 5),
  quick          jsonb,                         -- быстрый словарь: перевод, произношение
  card           jsonb,                         -- подробный разбор: этимология, история, факт
  contexts       jsonb not null default '[]'::jsonb, -- объяснения для конкретных предложений
  notes          text,                          -- ваши заметки
  first_chapter  uuid references public.chapters(id) on delete set null,
  learned_at     timestamptz,
  has_card       boolean generated always as (card is not null) stored,
  created_at     timestamptz not null default now(),
  primary key (user_id, word)
);

create table if not exists public.settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists chapters_user_position_idx on public.chapters (user_id, position, created_at);

-- Доступ: гостям (anon) — ничего, вошедшему пользователю — только его строки.
revoke all on public.chapters, public.words, public.settings from anon;
grant select, insert, update, delete on public.chapters, public.words, public.settings to authenticated;

alter table public.chapters enable row level security;
alter table public.words    enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own rows" on public.chapters;
create policy "own rows" on public.chapters for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own rows" on public.words;
create policy "own rows" on public.words for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own rows" on public.settings;
create policy "own rows" on public.settings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Пустой запрос для автопинга, чтобы бесплатный проект не засыпал. Никаких данных не отдаёт.
create or replace function public.ping() returns integer
  language sql stable as $$ select 1 $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
