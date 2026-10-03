-- Full ingestion and rendering metadata for the real manga/manhwa pipeline.
alter table public.chapters
  add column if not exists source_type text not null default 'images'
    check (source_type in ('images','pdf','url')),
  add column if not exists source_url text,
  add column if not exists source_canonical_url text,
  add column if not exists source_sha256 text,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb,
  add column if not exists pipeline_version text not null default 'v2',
  add column if not exists progress_json jsonb not null default '{}'::jsonb,
  add column if not exists error_message text,
  add column if not exists source_path text,
  add column if not exists source_mime text,
  add column if not exists source_filename text;

alter table public.pages
  add column if not exists original_sha256 text,
  add column if not exists translated_sha256 text,
  add column if not exists authorized_mask_path text,
  add column if not exists render_version text;

create index if not exists chapters_source_canonical_url_idx
  on public.chapters(source_canonical_url)
  where source_canonical_url is not null;

create index if not exists pages_original_sha256_idx
  on public.pages(original_sha256)
  where original_sha256 is not null;
