import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAnonymousSessionId } from "@/lib/anonymous/session";

type Work = {
  seriesId: string; isBookmarked?: boolean; isFavorite?: boolean; translationCompleted?: boolean;
  lastChapterId?: string | null; lastPageNumber?: number | null; updatedAt?: string;
};
type History = {
  seriesId: string; chapterId?: string | null; lastPageNumber: number; lastReadAt?: string;
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const sessionId = await getAnonymousSessionId();
  if (!sessionId) return NextResponse.json({ migrated: false, reason: "no_anonymous_session" });

  const body = await req.json().catch(() => ({}));
  const migrationKey = typeof body?.migrationKey === "string" && body.migrationKey.length <= 128
    ? body.migrationKey : sessionId;
  const works = Array.isArray(body?.works) ? body.works as Work[] : [];
  const history = Array.isArray(body?.history) ? body.history as History[] : [];
  const admin = createAdminClient();

  const { data: previous } = await admin.from("migration_events").select("id")
    .eq("anonymous_session_id", sessionId).eq("user_id", user.id).eq("migration_key", migrationKey).maybeSingle();
  if (previous) return NextResponse.json({ migrated: true, duplicate: true });

  const { data: seriesRows, error: seriesError } = await admin.from("manga_series")
    .select("id, owner_id").eq("anonymous_session_id", sessionId);
  if (seriesError) return NextResponse.json({ error: seriesError.message }, { status: 500 });

  const ownedSeries = new Set<string>();
  for (const series of seriesRows ?? []) {
    if (series.owner_id && series.owner_id !== user.id) {
      return NextResponse.json({ error: "Conflito de propriedade na migração." }, { status: 409 });
    }
    ownedSeries.add(series.id);
  }

  const allowedWork = works.filter((item) => ownedSeries.has(item.seriesId));
  const allowedHistory = history.filter((item) => ownedSeries.has(item.seriesId));

  const { error: claimError } = await admin.from("manga_series")
    .update({ owner_id: user.id, anonymous_session_id: null })
    .eq("anonymous_session_id", sessionId).is("owner_id", null);
  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });

  for (const work of allowedWork) {
    const { data: existing } = await admin.from("user_work_state")
      .select("is_bookmarked,is_favorite,translation_completed,last_chapter_id,last_page_number,updated_at")
      .eq("user_id", user.id).eq("series_id", work.seriesId).maybeSingle();
    const incomingUpdatedAt = work.updatedAt ?? new Date().toISOString();
    const useIncomingPosition = !existing?.updated_at || incomingUpdatedAt >= existing.updated_at;

    const { error } = await admin.from("user_work_state").upsert({
      user_id: user.id, series_id: work.seriesId,
      is_bookmarked: Boolean(existing?.is_bookmarked || work.isBookmarked),
      is_favorite: Boolean(existing?.is_favorite || work.isFavorite),
      translation_completed: Boolean(existing?.translation_completed || work.translationCompleted),
      last_chapter_id: useIncomingPosition ? (work.lastChapterId ?? null) : existing?.last_chapter_id ?? null,
      last_page_number: useIncomingPosition ? (work.lastPageNumber ?? null) : existing?.last_page_number ?? null,
      updated_at: useIncomingPosition ? incomingUpdatedAt : existing?.updated_at ?? incomingUpdatedAt,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  for (const item of allowedHistory) {
    const lastReadAt = item.lastReadAt ?? new Date().toISOString();
    const { data: existing } = await admin.from("user_reading_history").select("last_read_at")
      .eq("user_id", user.id).eq("series_id", item.seriesId).eq("chapter_id", item.chapterId ?? null).maybeSingle();
    if (existing?.last_read_at && existing.last_read_at >= lastReadAt) continue;

    const { error } = await admin.from("user_reading_history").upsert({
      user_id: user.id, series_id: item.seriesId, chapter_id: item.chapterId ?? null,
      last_page_number: Math.max(1, Number(item.lastPageNumber) || 1), last_read_at: lastReadAt,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: eventError } = await admin.from("migration_events").insert({
    anonymous_session_id: sessionId, user_id: user.id, migration_key: migrationKey, status: "completed",
  });
  if (eventError) {
    if (eventError.code === "23505") return NextResponse.json({ migrated: true, duplicate: true });
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  return NextResponse.json({ migrated: true, duplicate: false, works: allowedWork.length, history: allowedHistory.length });
}
