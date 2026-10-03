import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAnonymousSessionId } from "@/lib/anonymous/session";

export async function getActor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) return { userId: user.id, anonymousSessionId: null };

  const anonymousSessionId = await getAnonymousSessionId();
  if (!anonymousSessionId) return null;
  return { userId: null, anonymousSessionId };
}

export async function assertSeriesAccess(seriesId: string) {
  const actor = await getActor();
  if (!actor) return null;

  const admin = createAdminClient();
  let query = admin.from("manga_series").select("id,owner_id,anonymous_session_id,title,status").eq("id", seriesId);

  query = actor.userId
    ? query.eq("owner_id", actor.userId)
    : query.eq("anonymous_session_id", actor.anonymousSessionId!);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ? { actor, series: data } : null;
}

export async function assertChapterAccess(chapterId: string) {
  const admin = createAdminClient();
  const { data: chapter, error } = await admin
    .from("chapters")
    .select("id,series_id,chapter_number,title,status,manga_series!inner(id,owner_id,anonymous_session_id)")
    .eq("id", chapterId)
    .maybeSingle();

  if (error) throw error;
  if (!chapter) return null;

  const actor = await getActor();
  if (!actor) return null;

  const series = chapter.manga_series as unknown as {
    id: string; owner_id: string | null; anonymous_session_id: string | null;
  };
  const allowed = actor.userId
    ? series.owner_id === actor.userId
    : series.anonymous_session_id === actor.anonymousSessionId;

  return allowed ? { actor, chapter, series } : null;
}
