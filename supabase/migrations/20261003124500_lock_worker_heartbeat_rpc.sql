revoke all on function public.heartbeat_translation_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.heartbeat_translation_job(uuid, text, integer) to service_role;
