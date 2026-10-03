import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActor } from "@/lib/anonymous/access";
import { canonicalizeSourceUrl } from "@/lib/ingest/url";

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
    if (!rawUrl) return NextResponse.json({ error: "Informe a URL da página de leitura." }, { status: 400 });

    let sourceUrl: string;
    try { sourceUrl = canonicalizeSourceUrl(rawUrl); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "URL inválida." }, { status: 400 }); }

    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Não foi possível iniciar a sessão anônima." }, { status: 401 });

    const admin = createAdminClient();
    const { data: candidates, error: lookupError } = await admin
      .from("chapters")
      .select("id,series_id,chapter_number,title,status,manga_series!inner(id,title,owner_id,anonymous_session_id,status)")
      .eq("source_canonical_url", sourceUrl).limit(20);
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });

    const existing = (candidates ?? []).find((item: any) => {
      const series = item.manga_series;
      return actor.userId ? series.owner_id === actor.userId : series.anonymous_session_id === actor.anonymousSessionId;
    });
    if (existing) {
      const series = existing.manga_series;
      return NextResponse.json({ reused: true, seriesId: series.id, chapterId: existing.id, title: series.title, chapterNumber: existing.chapter_number, status: existing.status });
    }

    const fingerprint = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16);
    const baseTitle = "Detectando obra…";
    const slugBase = slugify("obra-" + fingerprint) || ("obra-" + fingerprint);
    let slug = slugBase;
    let suffix = 2;
    while (true) {
      const { data: existingSlug, error: slugError } = await admin.from("manga_series").select("id").eq("slug", slug).maybeSingle();
      if (slugError) return NextResponse.json({ error: slugError.message }, { status: 500 });
      if (!existingSlug) break;
      slug = slugBase + "-" + suffix++;
    }

    const { data: series, error: seriesError } = await admin.from("manga_series").insert({
      owner_id: actor.userId, anonymous_session_id: actor.anonymousSessionId,
      title: baseTitle, slug, status: "processing",
    }).select("id,title,status").single();
    if (seriesError || !series) return NextResponse.json({ error: seriesError?.message ?? "Falha ao criar obra." }, { status: 500 });

    const { data: chapter, error: chapterError } = await admin.from("chapters").insert({
      series_id: series.id, chapter_number: 0, title: null, status: "processing",
      source_type: "url", source_url: sourceUrl, source_canonical_url: sourceUrl,
      pipeline_version: "v2", progress_json: { stage: "identifying", overall: 0, identification: 0 },
    }).select("id,chapter_number,status").single();
    if (chapterError || !chapter) {
      await admin.from("manga_series").delete().eq("id", series.id);
      return NextResponse.json({ error: chapterError?.message ?? "Falha ao criar capítulo." }, { status: 500 });
    }

    const { data: job, error: jobError } = await admin.rpc("enqueue_translation_job", {
      p_job_type: "process_chapter", p_chapter_id: chapter.id,
      p_input_json: {
        requested_by: actor.userId, anonymous_session_id: actor.anonymousSessionId,
        pipeline_version: "v2", automatic_url_import: true, source_url: sourceUrl,
      }, p_force: false,
    });
    if (jobError) {
      await admin.from("chapters").update({ status: "error", error_message: jobError.message }).eq("id", chapter.id);
      return NextResponse.json({ error: jobError.message }, { status: 500 });
    }

    return NextResponse.json({ reused: false, seriesId: series.id, chapterId: chapter.id, title: series.title, chapterNumber: chapter.chapter_number, job });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao iniciar importação automática." }, { status: 500 });
  }
}
