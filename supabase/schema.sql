-- Palabra por palabra: database.
-- Paste the whole file into Supabase → SQL Editor → New query and press Run.
-- Safe to run again at any time: it never deletes data.
-- Run it again after updating the site, so that new columns are added to an existing database.

create table if not exists public.chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null,
  lang        text not null default 'es',            -- language of the text, e.g. es, fr, ja, de
  paragraphs  jsonb not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.words (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lang           text not null default 'es',
  word           text not null,
  level          smallint not null default 5 check (level between 1 and 5),
  quick          jsonb,                              -- quick dictionary: translation, pronunciation
  card           jsonb,                              -- detailed analysis: etymology, history, fact
  contexts       jsonb not null default '[]'::jsonb, -- explanations for particular sentences
  notes          text,                               -- your notes
  srs            jsonb,                              -- review schedule: interval, next due date
  first_chapter  uuid references public.chapters(id) on delete set null,
  learned_at     timestamptz,
  has_card       boolean generated always as (card is not null) stored,
  created_at     timestamptz not null default now(),
  primary key (user_id, lang, word)
);

create table if not exists public.settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Upgrades for databases created by earlier versions. Existing words and chapters become Spanish.
alter table public.chapters add column if not exists lang text not null default 'es';
alter table public.words    add column if not exists lang text not null default 'es';
alter table public.words    add column if not exists srs  jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'public.words'::regclass and i.indisprimary and a.attname = 'lang'
  ) then
    alter table public.words drop constraint if exists words_pkey;
    alter table public.words add constraint words_pkey primary key (user_id, lang, word);
  end if;
end $$;

create index if not exists chapters_user_position_idx on public.chapters (user_id, position, created_at);

-- Access: guests (anon) get nothing, a signed-in user gets only their own rows.
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

-- An empty call for the keep-alive ping, so the free project doesn't pause. Returns no data.
create or replace function public.ping() returns integer
  language sql stable as $$ select 1 $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- Let the API see the new columns right away.
notify pgrst, 'reload schema';
