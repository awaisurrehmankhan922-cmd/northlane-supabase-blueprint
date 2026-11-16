-- Storage policies (Supabase only: the storage schema does not exist on plain Postgres,
-- so this file is applied with `supabase db push` and is not part of the CI migrations).
--
-- Four private buckets, one per kind of file (page 19). The browser never reads a bucket
-- directly: the Node API hands out short-lived signed URLs (60 s) after checking the row
-- in public.files the object belongs to. These policies are the second lock in case
-- the API is ever bypassed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('documents',         'documents',         false, 26214400, array['application/pdf','image/jpeg','image/png']),
  ('id-copies',         'id-copies',         false, 10485760, array['application/pdf','image/jpeg','image/png']),
  ('inspection-photos', 'inspection-photos', false, 15728640, array['image/jpeg','image/png','image/heic']),
  ('signing-pages',     'signing-pages',     false, 26214400, array['application/pdf','image/png'])
on conflict (id) do nothing;

-- Object path convention: <branch>/<coll>/<record id>/<file key>
-- so the branch is the first folder and policies can read it without a join.
create or replace function app.object_branch(name text) returns text
language sql immutable as $$ select split_part(name, '/', 1) $$;

alter table storage.objects enable row level security;

-- aal2 everywhere, as for every table
drop policy if exists needs_aal2 on storage.objects;
create policy needs_aal2 on storage.objects as restrictive for all to authenticated
  using (app.aal2()) with check (app.aal2());

-- Read: your branch (or all, for shared roles); ID copies only with the switch.
create policy objects_read on storage.objects for select to authenticated
  using (
    app.sees_branch(app.object_branch(name))
    and (bucket_id <> 'id-copies' or app.can('viewIdDocuments'))
  );

-- Upload: into your own branch's folder only, and the files row must exist first
-- (the API inserts it with sha256 and size after the upload checks).
create policy objects_insert on storage.objects for insert to authenticated
  with check (
    app.writes_branch(app.object_branch(name))
    and exists (select 1 from public.files f where f.key = name and f.uploader = app.uid())
  );

-- No update, no delete for staff. A new upload is a new version; the old one is kept.
-- Erasure for data protection runs as service_role from the retention job.
