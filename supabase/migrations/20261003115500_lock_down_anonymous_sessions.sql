-- anonymous_sessions is server-side only; do not expose it through the Data API.
alter table public.anonymous_sessions enable row level security;

revoke all
on table public.anonymous_sessions
from anon, authenticated;
