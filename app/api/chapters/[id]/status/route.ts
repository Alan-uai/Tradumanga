import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertChapterAccess } from "@/lib/anonymous/access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await assertChapterAccess(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const admin = createAdminClient();
    const { data: pages, error } = await admin.from("pages")
      .select("id,status,error_message")
      .eq("chapter_id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const counts = { queued: 0, analyzing: 0, analyzed: 0, translating: 0, translated: 0, rendering: 0, ready: 0, error: 0 };
    for (const page of pages ?? []) {
      const key = page.status as keyof typeof counts;
      if (key in counts) counts[key]++;
    }

    const progress = access.chapter.progress_json ?? {};
    return NextResponse.json({
      chapter: {
        id,
        chapterNumber: access.chapter.chapter_number,
        title: access.chapter.title,
        status: access.chapter.status,
        errorMessage: access.chapter.error_message,
        progress,
      },
      pages: counts,
      totalPages: pages?.length ?? 0,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao consultar processamento." }, { status: 500 });
  }
}
