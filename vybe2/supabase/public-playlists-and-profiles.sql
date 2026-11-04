alter table public.playlists
  add column if not exists is_public boolean not null default false,
  add column if not exists source_playlist_id uuid references public.playlists (id) on delete set null;

alter table public.playlists drop constraint if exists playlists_official_not_public;
alter table public.playlists
  add constraint playlists_official_not_public check (not (is_official and is_public));

create index if not exists playlists_public_idx
  on public.playlists (updated_at desc) where is_public;

-- Tracks follow automatically: their policy allows any playlist the reader can see.
drop policy if exists "public can read public listener playlists" on public.playlists;
create policy "public can read public listener playlists"
  on public.playlists for select to anon, authenticated
  using (is_public and not is_official);


-- 2. PROFILES ----------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- A name is only visible to others once its owner has shared a public playlist.
drop policy if exists "read own or sharing profiles" on public.profiles;
create policy "read own or sharing profiles"
  on public.profiles for select to anon, authenticated
  using (
    id = auth.uid()
    or exists (select 1 from public.playlists p where p.owner_id = profiles.id and p.is_public)
  );

drop policy if exists "listeners rename themselves" on public.profiles;
create policy "listeners rename themselves"
  on public.profiles for update to authenticated
  using      (id = auth.uid())
  with check (id = auth.uid());

-- Every new account gets a profile. Email addresses are never used for the name.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Listener'), 60)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;

drop trigger if exists create_profile_for_new_user on auth.users;
create trigger create_profile_for_new_user
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

-- Accounts that already exist get a profile too.
insert into public.profiles (id, display_name)
select id, left(coalesce(nullif(btrim(raw_user_meta_data ->> 'display_name'), ''), 'Listener'), 60)
from auth.users
on conflict (id) do nothing;


-- 3. MODERATION --------------------------------------------------------------
-- Admins can't read private playlists or edit anyone's playlist. These two actions
-- are the only things they can do to listeners' public content.
create or replace function public.hide_public_playlist(target uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    return false;
  end if;
  update public.playlists set is_public = false
  where id = target and is_public and not is_official;
  return found;
end;
$$;

revoke all on function public.hide_public_playlist(uuid) from public, anon, authenticated;
grant execute on function public.hide_public_playlist(uuid) to authenticated;

create or replace function public.reset_profile_name(target uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    return false;
  end if;
  update public.profiles set display_name = 'Listener' where id = target;
  return found;
end;
$$;

revoke all on function public.reset_profile_name(uuid) from public, anon, authenticated;
grant execute on function public.reset_profile_name(uuid) to authenticated;


-- Make the changes available to the API straight away.
notify pgrst, 'reload schema';
