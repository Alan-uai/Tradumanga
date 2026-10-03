import { NextResponse } from "next/server";
import { analyzePageWithGemini } from "@/lib/pipeline/gemini";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      pageId,
      imageBase64,
      mimeType = "image/jpeg",
    } = body;

    if (!pageId || !imageBase64) {
      return NextResponse.json(
        { error: "pageId e imageBase64 são obrigatórios" },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    }

    const { data: page } = await supabase
      .from("pages")
      .select("id, chapter_id")
      .eq("id", pageId)
      .single();

    if (!page) {
      return NextResponse.json({ error: "Página não encontrada" }, { status: 404 });
    }

    const { data: chapter } = await supabase
      .from("chapters")
      .select("series_id")
      .eq("id", page.chapter_id)
      .single();

    const { data: series } = chapter
      ? await supabase
          .from("manga_series")
          .select("owner_id, source_language, target_language")
          .eq("id", chapter.series_id)
          .single()
      : { data: null };

    if (!series || series.owner_id !== user.id) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    }

    const parsed = await analyzePageWithGemini({
      imageBase64,
      mimeType,
    });

    const bubbles = Array.isArray(parsed.bubbles) ? parsed.bubbles : [];

    const { data: analysis, error } = await supabase
      .from("page_analyses")
      .insert({
        page_id: pageId,
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        model_version: null,
        source_language: series.source_language,
        target_language: series.target_language,
        story_context:
          typeof parsed.story_context === "string"
            ? parsed.story_context
            : null,
        visual_context:
          typeof parsed.visual_context === "string"
            ? parsed.visual_context
            : null,
        ocr_text: bubbles
          .map((bubble) =>
            typeof bubble === "object" &&
            bubble !== null &&
            "source_text" in bubble &&
            typeof bubble.source_text === "string"
              ? bubble.source_text
              : "",
          )
          .filter(Boolean)
          .join("\n"),
        analysis_json: parsed,
      })
      .select("id")
      .single();

    if (error) throw error;

    for (const bubble of bubbles) {
      if (!bubble || typeof bubble !== "object") continue;

      const item = bubble as Record<string, unknown>;
      const bubbleIndex =
        typeof item.bubble_index === "number" ? item.bubble_index : null;

      if (bubbleIndex === null) continue;

      await supabase.from("speech_bubbles").upsert(
        {
          page_id: pageId,
          bubble_index: bubbleIndex,
          polygon: Array.isArray(item.polygon) ? item.polygon : [],
          bbox:
            item.bbox && typeof item.bbox === "object" ? item.bbox : null,
          source_text:
            typeof item.source_text === "string" ? item.source_text : null,
          translated_text: null,
          translation_notes: null,
          confidence:
            typeof item.confidence === "number" ? item.confidence : null,
          style_json: {
            ...(item.style_json &&
            typeof item.style_json === "object"
              ? item.style_json
              : {}),
            intent:
              typeof item.intent === "string" ? item.intent : null,
            speaker_hint:
              typeof item.speaker_hint === "string"
                ? item.speaker_hint
                : null,
          },
        },
        { onConflict: "page_id,bubble_index" },
      );
    }

    await supabase
      .from("pages")
      .update({ status: "analyzed", error_message: null })
      .eq("id", pageId);

    return NextResponse.json({
      analysisId: analysis.id,
      result: parsed,
      translated: false,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha na análise",
      },
      { status: 500 },
    );
  }
}
