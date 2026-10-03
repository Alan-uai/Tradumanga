import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const chapterId = typeof body?.chapterId === "string" ? body.chapterId : "";

    if (!chapterId) {
      return NextResponse.json({ error: "chapterId é obrigatório" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    }

    const { data: chapter, error: chapterError } = await supabase
      .from("chapters")
      .select("id, series_id")
      .eq("id", chapterId)
      .single();

    if (chapterError || !chapter) {
      return NextResponse.json({ error: "Capítulo não encontrado" }, { status: 404 });
    }

    const { data: series, error: seriesError } = await supabase
      .from("manga_series")
      .select("owner_id")
      .eq("id", chapter.series_id)
      .single();

    if (seriesError || !series || series.owner_id !== user.id) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    }

    const { data: job, error: jobError } = await supabase.rpc(
      "enqueue_translation_job",
      {
        p_job_type: "process_chapter",
        p_chapter_id: chapter.id,
        p_input_json: {
          requested_by: user.id,
          pipeline_version: "v1",
        },
        p_force: false,
      },
    );

    if (jobError) {
      return NextResponse.json({ error: jobError.message }, { status: 500 });
    }

    const { error: statusError } = await supabase
      .from("chapters")
      .update({ status: "processing" })
      .eq("id", chapter.id);

    if (statusError) {
      return NextResponse.json({ error: statusError.message }, { status: 500 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao enfileirar capítulo" },
      { status: 500 },
    );
  }
}
