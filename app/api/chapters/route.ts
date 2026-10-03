import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSeriesAccess } from "@/lib/anonymous/access";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const seriesId = typeof body?.seriesId === "string" ? body.seriesId : "";
    const chapterNumber = Number(body?.chapterNumber);
    if (!seriesId || !Number.isFinite(chapterNumber)) {
      return NextResponse.json({ error: "seriesId e chapterNumber são obrigatórios." }, { status: 400 });
    }

    const access = await assertSeriesAccess(seriesId);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const admin = createAdminClient();
    const { data, error } = await admin.from("chapters").insert({
      series_id: seriesId, chapter_number: chapterNumber, status: "processing",
    }).select("id,chapter_number,status").single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ chapter: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao criar capítulo." }, { status: 500 });
  }
}
