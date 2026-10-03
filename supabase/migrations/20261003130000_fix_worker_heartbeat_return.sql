create or replace function public.heartbeat_translation_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 1800
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_rows bigint;
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  update public.translation_jobs
  set lock_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and status = 'running'
    and worker_id = p_worker_id;

  get diagnostics v_rows = row_count;

  return v_rows > 0;
end;
$function$;

revoke all on function public.heartbeat_translation_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.heartbeat_translation_job(uuid, text, integer) to service_role;
