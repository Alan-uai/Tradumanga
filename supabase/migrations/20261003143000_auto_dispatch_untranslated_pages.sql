-- Automatically dispatch analyzed pages that still lack a translated artifact.
-- The INNGEST_EVENT_KEY secret must be created separately in Supabase Vault.

create or replace function public.dispatch_untranslated_page_to_inngest()
returns trigger
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_event_key text;
begin
  if new.translated_path is not null or new.status <> 'analyzed' then
    return new;
  end if;

  select decrypted_secret
    into v_event_key
  from vault.decrypted_secrets
  where name = 'INNGEST_EVENT_KEY'
  limit 1;

  if v_event_key is null or length(trim(v_event_key)) = 0 then
    raise warning 'INNGEST_EVENT_KEY is not configured; page % was not dispatched', new.id;
    return new;
  end if;

  perform net.http_post(
    url := 'https://inn.gs/e/' || v_event_key,
    body := jsonb_build_object(
      'id', 'translate:' || new.id::text,
      'name', 'tradumanga/page.translate',
      'data', jsonb_build_object(
        'pageId', new.id::text,
        'source', 'supabase-untranslated-page-webhook'
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

revoke execute on function public.dispatch_untranslated_page_to_inngest() from public;
revoke execute on function public.dispatch_untranslated_page_to_inngest() from anon;
revoke execute on function public.dispatch_untranslated_page_to_inngest() from authenticated;

drop trigger if exists pages_dispatch_untranslated_page on public.pages;

create trigger pages_dispatch_untranslated_page
after insert or update of status, translated_path
on public.pages
for each row
when (new.translated_path is null and new.status = 'analyzed')
execute function public.dispatch_untranslated_page_to_inngest();

comment on function public.dispatch_untranslated_page_to_inngest() is
'Dispatches analyzed pages without translated_path to tradumanga/page.translate in Inngest. Event IDs are deterministic per page.';
