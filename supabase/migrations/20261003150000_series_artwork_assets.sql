alter table public.manga_series
  add column if not exists logo_path text,
  add column if not exists banner_path text;
