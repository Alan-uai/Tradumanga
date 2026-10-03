import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { assertChapterAccess } from "@/lib/anonymous/access";
import { getAnonymousSessionId } from "@/lib/anonymous/session";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const body = await req.json().catch(() => ({}));
  const seriesId = typeof body?.seriesId === "string" ? body.seriesId : "";
  const chapterId = typeof body?.chapterId === "string" ? body.chapterId : "";
  const page = Math.max(1, Number(body?.lastPageNumber) || 1);
  const lastReadAt = typeof body?.lastReadAt === "string" ? body.lastReadAt : new Date().toISOString();

  if (!seriesId || !chapterId) return NextResponse.json({ error: "Dados incompletos." }, { status: 400 });

  const access = await assertChapterAccess(chapterId);
  if (!access || access.chapter.series_id !== seriesId) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

  if (!user) {
    return NextResponse.json({ saved: false, localOnly: Boolean(await getAnonymousSessionId()) });
  }

  const admin = createAdminClient();
  const { data: existing } = await admin.from("user_reading_history").select("id,last_read_at")
    .eq("user_id", user.id).eq("series_id", seriesId).eq("chapter_id", chapterId).maybeSingle();

  if (existing?.last_read_at && existing.last_read_at >= lastReadAt) {
    return NextResponse.json({ saved: true, unchanged: true });
  }

  const payload = {
    user_id: user.id, series_id: seriesId, chapter_id: chapterId,
    last_page_number: page, last_read_at: lastReadAt,
  };

  const result = existing
    ? await admin.from("user_reading_history").update(payload).eq("id", existing.id)
    : await admin.from("user_reading_history").insert(payload);

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  return NextResponse.json({ saved: true });
}
