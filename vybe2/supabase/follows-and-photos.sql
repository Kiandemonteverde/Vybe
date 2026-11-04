create table if not exists public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_not_yourself check (follower_id <> following_id)
);

create index if not exists follows_following_idx on public.follows (following_id, created_at desc);
create index if not exists follows_follower_idx on public.follows (follower_id, created_at desc);

alter table public.follows enable row level security;

revoke all on public.follows from anon, authenticated;
grant select on public.follows to anon, authenticated;
grant insert, delete on public.follows to authenticated;

drop policy if exists "anyone can read follows" on public.follows;
create policy "anyone can read follows"
  on public.follows for select to anon, authenticated
  using (true);

-- You can only follow people whose profile you're able to see.
drop policy if exists "listeners follow as themselves" on public.follows;
create policy "listeners follow as themselves"
  on public.follows for insert to authenticated
  with check (
    follower_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = following_id)
  );

drop policy if exists "listeners unfollow as themselves" on public.follows;
create policy "listeners unfollow as themselves"
  on public.follows for delete to authenticated
  using (follower_id = auth.uid());


-- 2. WHO CAN SEE A PROFILE ---------------------------------------------------
-- Following someone puts your name and photo on their public followers list,
-- so a profile is visible once its owner shares a playlist or takes part in follows.
drop policy if exists "read own or sharing profiles" on public.profiles;
create policy "read own or sharing profiles"
  on public.profiles for select to anon, authenticated
  using (
    id = auth.uid()
    or exists (select 1 from public.playlists p where p.owner_id = profiles.id and p.is_public)
    or exists (select 1 from public.follows f where f.follower_id = profiles.id or f.following_id = profiles.id)
  );

-- Admins can see every profile so they can moderate photos. Private playlists stay private.
drop policy if exists "admins read all profiles" on public.profiles;
create policy "admins read all profiles"
  on public.profiles for select to authenticated
  using (public.is_admin());


-- 3. PROFILE PHOTOS ----------------------------------------------------------
alter table public.profiles add column if not exists avatar_path text;

-- A profile can only point at a photo in its owner's own folder.
alter table public.profiles drop constraint if exists profiles_avatar_in_own_folder;
alter table public.profiles
  add constraint profiles_avatar_in_own_folder
  check (avatar_path is null or avatar_path like id::text || '/%');

grant update (display_name, avatar_path) on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Listeners manage files only inside a folder named after their own account.
drop policy if exists "listeners read own photos" on storage.objects;
create policy "listeners read own photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "listeners add own photos" on storage.objects;
create policy "listeners add own photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "listeners delete own photos" on storage.objects;
create policy "listeners delete own photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Admins can read and remove any photo, and nothing else about listeners' accounts.
drop policy if exists "admins read photos" on storage.objects;
create policy "admins read photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and public.is_admin());

drop policy if exists "admins remove photos" on storage.objects;
create policy "admins remove photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and public.is_admin());

create or replace function public.remove_profile_photo(target uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    return false;
  end if;
  update public.profiles set avatar_path = null where id = target and avatar_path is not null;
  return found;
end;
$$;

revoke all on function public.remove_profile_photo(uuid) from public, anon, authenticated;
grant execute on function public.remove_profile_photo(uuid) to authenticated;


-- Make the changes available to the API straight away.
notify pgrst, 'reload schema';
