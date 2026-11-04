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
