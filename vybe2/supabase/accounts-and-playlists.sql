create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 100),
  description text          check (char_length(description) <= 500),
  cover_path  text,                               -- object name in the "covers" bucket
  owner_id    uuid references auth.users (id) on delete cascade,
  is_official boolean not null default false,
  published   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint playlists_need_an_owner check (is_official or owner_id is not null)
);

create index if not exists playlists_owner_idx on public.playlists (owner_id);
create index if not exists playlists_official_idx on public.playlists (is_official, published);

alter table public.playlists enable row level security;

-- Clear Supabase's default table permissions so only what's granted here applies.
revoke all on public.playlists from anon, authenticated;
grant select on public.playlists to anon;
grant select, insert, update, delete on public.playlists to authenticated;

drop policy if exists "public can read published official playlists" on public.playlists;
create policy "public can read published official playlists"
  on public.playlists for select to anon, authenticated
  using (is_official and published);

drop policy if exists "listeners manage own playlists" on public.playlists;
create policy "listeners manage own playlists"
  on public.playlists for all to authenticated
  using      (owner_id = auth.uid() and not is_official)
  with check (owner_id = auth.uid() and not is_official);

-- Admins manage official playlists only, so listeners' playlists stay private.
drop policy if exists "admins manage official playlists" on public.playlists;
create policy "admins manage official playlists"
  on public.playlists for all to authenticated
  using      (is_official and public.is_admin())
  with check (is_official and public.is_admin());

create or replace function public.playlists_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists playlists_before_write on public.playlists;
create trigger playlists_before_write
  before insert or update on public.playlists
  for each row execute function public.playlists_before_write();


-- 2. PLAYLIST TRACKS ---------------------------------------------------------
create table if not exists public.playlist_songs (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  song_id     uuid not null references public.songs (id) on delete cascade,
  position    integer not null default 0 check (position >= 0),
  added_at    timestamptz not null default now(),
  primary key (playlist_id, song_id)
);

create index if not exists playlist_songs_song_idx on public.playlist_songs (song_id);
create index if not exists playlist_songs_order_idx on public.playlist_songs (playlist_id, position);

alter table public.playlist_songs enable row level security;

revoke all on public.playlist_songs from anon, authenticated;
grant select on public.playlist_songs to anon;
grant select, insert, update, delete on public.playlist_songs to authenticated;

-- True when the signed-in user may change this playlist.
create or replace function public.can_edit_playlist(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.playlists p
    where p.id = target
      and (
        (not p.is_official and p.owner_id = auth.uid())
        or (p.is_official and public.is_admin())
      )
  );
$$;

revoke all on function public.can_edit_playlist(uuid) from public;
grant execute on function public.can_edit_playlist(uuid) to authenticated;

-- Tracks are readable whenever their playlist is (the playlists policies apply here).
drop policy if exists "read tracks of readable playlists" on public.playlist_songs;
create policy "read tracks of readable playlists"
  on public.playlist_songs for select to anon, authenticated
  using (exists (select 1 from public.playlists p where p.id = playlist_id));

-- Listeners may only add published songs. Admins may also add drafts.
drop policy if exists "add tracks to editable playlists" on public.playlist_songs;
create policy "add tracks to editable playlists"
  on public.playlist_songs for insert to authenticated
  with check (
    public.can_edit_playlist(playlist_id)
    and (
      public.is_admin()
      or exists (select 1 from public.songs s where s.id = song_id and s.published)
    )
  );

drop policy if exists "reorder tracks of editable playlists" on public.playlist_songs;
create policy "reorder tracks of editable playlists"
  on public.playlist_songs for update to authenticated
  using      (public.can_edit_playlist(playlist_id))
  with check (public.can_edit_playlist(playlist_id));

drop policy if exists "remove tracks from editable playlists" on public.playlist_songs;
create policy "remove tracks from editable playlists"
  on public.playlist_songs for delete to authenticated
  using (public.can_edit_playlist(playlist_id));


-- 3. LIKED SONGS -------------------------------------------------------------
create table if not exists public.liked_songs (
  user_id    uuid not null references auth.users (id) on delete cascade,
  song_id    uuid not null references public.songs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, song_id)
);

create index if not exists liked_songs_song_idx on public.liked_songs (song_id);

alter table public.liked_songs enable row level security;

revoke all on public.liked_songs from anon, authenticated;
grant select, insert, delete on public.liked_songs to authenticated;

drop policy if exists "listeners manage own likes" on public.liked_songs;
create policy "listeners manage own likes"
  on public.liked_songs for all to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());


-- Make the new tables available to the API straight away.
notify pgrst, 'reload schema';


-- 4. ADMIN ACCOUNTS ----------------------------------------------------------
-- Admins sign in with a normal account. To make an account an admin, create it
-- first, then run this with its email address:
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com'
--   on conflict do nothing;
