import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import { assertSourceUrl } from "@/lib/ingest/url";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const seriesId = typeof body?.seriesId === "string" ? body.seriesId : "";
    const chapterNumber = Number(body?.chapterNumber);
    const sourceType = body?.sourceType === "pdf" || body?.sourceType === "url" ? body.sourceType : "images";
    if (!seriesId || !Number.isFinite(chapterNumber)) {
      return NextResponse.json({ error: "seriesId e chapterNumber são obrigatórios." }, { status: 400 });
    }

    const access = await assertSeriesAccess(seriesId);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    let sourceUrl: string | null = null;
    if (sourceType === "url") {
      if (typeof body?.sourceUrl !== "string" || !body.sourceUrl.trim()) {
        return NextResponse.json({ error: "Informe a URL da fonte." }, { status: 400 });
      }
      try { sourceUrl = assertSourceUrl(body.sourceUrl); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "URL inválida." }, { status: 400 }); }
    }

    const admin = createAdminClient();
    const { data, error } = await admin.from("chapters").insert({
      series_id: seriesId,
      chapter_number: chapterNumber,
      status: "processing",
      source_type: sourceType,
      source_url: sourceUrl,
      source_canonical_url: sourceUrl,
      source_mime: sourceType === "pdf" ? "application/pdf" : null,
      source_filename: null,
      pipeline_version: "v2",
      progress_json: {},
    }).select("id,chapter_number,status,source_type").single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ chapter: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao criar capítulo." }, { status: 500 });
  }
}
