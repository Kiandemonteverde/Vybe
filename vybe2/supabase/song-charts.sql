create or replace function public.song_like_stats()
returns table (song_id uuid, total_likes bigint, recent_likes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.song_id,
    count(*) as total_likes,
    count(*) filter (where l.created_at > now() - interval '7 days') as recent_likes
  from public.liked_songs l
  join public.songs s on s.id = l.song_id and s.published
  group by l.song_id;
$$;

revoke all on function public.song_like_stats() from public, anon, authenticated;
grant execute on function public.song_like_stats() to anon, authenticated;

-- Make the function available to the API straight away.
notify pgrst, 'reload schema';
