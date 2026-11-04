-- 1. ADMINS --
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Nobody can add or change admins through the API. You do it in the SQL editor.
revoke all on public.admins from anon;
revoke insert, update, delete on public.admins from authenticated;

-- A signed-in user may see only their own row (lets admin.html check access).
drop policy if exists "admins can read own row" on public.admins;
create policy "admins can read own row"
  on public.admins for select to authenticated
  using (user_id = auth.uid());

-- Helper used by every policy below.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;


-- 2. SONGS --
create table if not exists public.songs (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title)  between 1 and 200),
  artist           text not null check (char_length(artist) between 1 and 200),
  album            text          check (char_length(album)  <= 200),
  genre            text          check (char_length(genre)  <= 100),
  audio_path       text not null unique,          -- object name in the "audio" bucket
  cover_path       text,                          -- object name in the "covers" bucket
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  published        boolean not null default false,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists songs_published_idx
  on public.songs (published, published_at desc);

alter table public.songs enable row level security;

-- Defence in depth: visitors have no write privileges at all.
revoke insert, update, delete on public.songs from anon;

-- Visitors (and signed-in non-admins) see published songs only.
drop policy if exists "public can read published songs" on public.songs;
create policy "public can read published songs"
  on public.songs for select to anon, authenticated
  using (published = true);

-- Admins can do everything, including seeing drafts.
drop policy if exists "admins manage songs" on public.songs;
create policy "admins manage songs"
  on public.songs for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Keep timestamps correct on the server, so the client can't fake them.
create or replace function public.songs_before_write()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.published then
    if tg_op = 'INSERT' or old.published is distinct from true then
      new.published_at := now();
    end if;
  else
    new.published_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists songs_before_write on public.songs;
create trigger songs_before_write
  before insert or update on public.songs
  for each row execute function public.songs_before_write();


-- 3. STORAGE BUCKETS ---------------------------------------------------------
-- audio  : PRIVATE. Streamed through short-lived signed URLs, which Postgres
--          only issues for songs that are published.
-- covers : public images (file names are random UUIDs, never listed).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('audio',  'audio',  false, 52428800, array['audio/mpeg', 'audio/mp3']),
  ('covers', 'covers', true,   5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- 4. STORAGE POLICIES --------------------------------------------------------
-- Admins: full control over both buckets (upload, replace, delete, preview drafts).
drop policy if exists "vybe admins manage files" on storage.objects;
create policy "vybe admins manage files"
  on storage.objects for all to authenticated
  using      (bucket_id in ('audio', 'covers') and public.is_admin())
  with check (bucket_id in ('audio', 'covers') and public.is_admin());

-- Logged-in listeners: may stream audio ONLY if a published song points at that file.
drop policy if exists "vybe public streams published audio" on storage.objects;
drop policy if exists "vybe listeners stream published audio" on storage.objects;
create policy "vybe listeners stream published audio"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'audio'
    and exists (
      select 1 from public.songs s
      where s.audio_path = storage.objects.name
        and s.published = true
    )
  );


