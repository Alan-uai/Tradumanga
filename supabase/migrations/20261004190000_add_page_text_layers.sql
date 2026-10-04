alter table public.pages
  add column if not exists clean_path text,
  add column if not exists layer_manifest_path text,
  add column if not exists layer_render_version text;

alter table public.speech_bubbles
  add column if not exists clean_layer_path text,
  add column if not exists text_layer_path text,
  add column if not exists layer_status text not null default 'pending';

alter table public.speech_bubbles
  drop constraint if exists speech_bubbles_layer_status_check;

alter table public.speech_bubbles
  add constraint speech_bubbles_layer_status_check
  check (layer_status in ('pending','cleaned','rendered','skipped','error'));

comment on column public.pages.clean_path is 'Base page with authorized source-text regions cleaned; original_path is immutable.';
comment on column public.pages.layer_manifest_path is 'JSON manifest describing independently renderable text layers for this page.';
comment on column public.speech_bubbles.clean_layer_path is 'Optional isolated cleaned-region artifact for this text layer.';
comment on column public.speech_bubbles.text_layer_path is 'Transparent rasterized PT-BR text layer for this text element.';
