import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  analyzePageWithGemini,
  buildChapterContext,
  translatePageWithGemini,
} from "../../lib/pipeline/gemini";

type Job = {
  id: string;
  page_id: string | null;
  chapter_id: string | null;
  job_type: "analyze_page" | "translate_page" | "render_page" | "process_chapter";
  attempts: number;
  input_json: Record<string, unknown>;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const workerId =
  process.env.WORKER_ID || `worker-${process.pid}-${Date.now()}`;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para o worker",
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function claimJob(): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_translation_job", {
    p_worker_id: workerId,
    p_lease_seconds: 300,
  });

  if (error) throw error;

  return Array.isArray(data) && data.length > 0 ? (data[0] as Job) : null;
}

async function completeJob(job: Job, output: Record<string, unknown> = {}) {
  const { error } = await supabase.rpc("complete_translation_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_output_json: output,
  });

  if (error) throw error;
}

async function failJob(job: Job, errorMessage: string) {
  const { error } = await supabase.rpc("fail_translation_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_error_message: errorMessage,
    p_output_json: {},
  });

  if (error) throw error;
}

async function enqueue(
  jobType: "analyze_page" | "translate_page",
  pageId: string,
) {
  const { error } = await supabase.rpc("enqueue_translation_job", {
    p_job_type: jobType,
    p_page_id: pageId,
    p_input_json: { pipeline_version: "v1" },
    p_force: false,
  });

  if (error) throw error;
}

async function processChapter(job: Job) {
  if (!job.chapter_id) throw new Error("process_chapter sem chapter_id");

  const { data: pages, error } = await supabase
    .from("pages")
    .select("id, page_number, status")
    .eq("chapter_id", job.chapter_id)
    .order("page_number");

  if (error) throw error;
  if (!pages?.length) throw new Error("Capítulo sem páginas");

  for (const page of pages) {
    await enqueue("analyze_page", page.id);
  }

  await supabase
    .from("chapters")
    .update({ status: "processing" })
    .eq("id", job.chapter_id);
}

async function storeAnalysis(
  pageId: string,
  sourceLanguage: string,
  targetLanguage: string,
  parsed: Record<string, unknown>,
) {
  const bubbles = Array.isArray(parsed.bubbles) ? parsed.bubbles : [];

  const { error } = await supabase.from("page_analyses").insert({
    page_id: pageId,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    model_version: null,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    story_context:
      typeof parsed.story_context === "string" ? parsed.story_context : null,
    visual_context:
      typeof parsed.visual_context === "string" ? parsed.visual_context : null,
    ocr_text: bubbles
      .map((bubble) =>
        bubble &&
        typeof bubble === "object" &&
        "source_text" in bubble &&
        typeof bubble.source_text === "string"
          ? bubble.source_text
          : "",
      )
      .filter(Boolean)
      .join("\n"),
    analysis_json: parsed,
  });

  if (error) throw error;

  for (const bubble of bubbles) {
    if (!bubble || typeof bubble !== "object") continue;

    const item = bubble as Record<string, unknown>;
    if (typeof item.bubble_index !== "number") continue;

    await supabase.from("speech_bubbles").upsert(
      {
        page_id: pageId,
        bubble_index: item.bubble_index,
        polygon: Array.isArray(item.polygon) ? item.polygon : [],
        bbox: item.bbox ?? null,
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
          intent: typeof item.intent === "string" ? item.intent : null,
          speaker_hint:
            typeof item.speaker_hint === "string" ? item.speaker_hint : null,
        },
      },
      { onConflict: "page_id,bubble_index" },
    );
  }
}

async function maybeBuildChapterContext(
  chapterId: string,
  title: string,
) {
  const { data: pages, error: pagesError } = await supabase
    .from("pages")
    .select("id, page_number, status")
    .eq("chapter_id", chapterId)
    .order("page_number");

  if (pagesError) throw pagesError;
  if (!pages?.length || pages.some((page) => page.status !== "analyzed")) return;

  const { data: chapter } = await supabase
    .from("chapters")
    .select("context_updated_at")
    .eq("id", chapterId)
    .single();

  if (chapter?.context_updated_at) return;

  const analyses = [];
  for (const page of pages) {
    const { data: analysis, error } = await supabase
      .from("page_analyses")
      .select("story_context, visual_context, analysis_json")
      .eq("page_id", page.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !analysis) return;

    const analysisJson =
      analysis.analysis_json &&
      typeof analysis.analysis_json === "object"
        ? (analysis.analysis_json as Record<string, unknown>)
        : {};

    analyses.push({
      page_number: page.page_number,
      story_context: analysis.story_context,
      visual_context: analysis.visual_context,
      bubbles: analysisJson.bubbles ?? [],
    });
  }

  const context = await buildChapterContext({ title, analyses });

  const { error: contextError } = await supabase
    .from("chapters")
    .update({
      context_text:
        typeof context.summary === "string" ? context.summary : null,
      context_json: context,
      context_model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      context_version: "v1",
      context_updated_at: new Date().toISOString(),
      status: "processing",
    })
    .eq("id", chapterId)
    .is("context_updated_at", null);

  if (contextError) throw contextError;

  for (const page of pages) {
    await enqueue("translate_page", page.id);
  }
}

async function processAnalysis(job: Job) {
  if (!job.page_id) throw new Error("analyze_page sem page_id");

  const { data: page, error: pageError } = await supabase
    .from("pages")
    .select(
      "id, original_path, chapter_id, chapters(series_id, chapter_number, title, manga_series(source_language, target_language, title))",
    )
    .eq("id", job.page_id)
    .single();

  if (pageError || !page) throw pageError || new Error("Página não encontrada");

  await supabase
    .from("pages")
    .update({ status: "analyzing", error_message: null })
    .eq("id", page.id);

  const { data: file, error: fileError } = await supabase.storage
    .from("manga-pages")
    .download(page.original_path);

  if (fileError || !file) {
    throw fileError || new Error("Não foi possível baixar a página original");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const imageBase64 = Buffer.from(bytes).toString("base64");
  const mimeType = file.type || "image/jpeg";

  const chapterData = page.chapters as unknown as {
    title: string | null;
    manga_series: {
      source_language: string;
      target_language: string;
      title: string;
    };
  };

  const parsed = await analyzePageWithGemini({
    imageBase64,
    mimeType,
  });

  await storeAnalysis(
    page.id,
    chapterData.manga_series.source_language,
    chapterData.manga_series.target_language,
    parsed,
  );

  await supabase
    .from("pages")
    .update({ status: "analyzed", error_message: null })
    .eq("id", page.id);

  await maybeBuildChapterContext(
    page.chapter_id,
    chapterData.title || chapterData.manga_series.title,
  );
}

async function processTranslation(job: Job) {
  if (!job.page_id) throw new Error("translate_page sem page_id");

  const { data: page, error: pageError } = await supabase
    .from("pages")
    .select(
      "id, chapter_id, chapters(title, context_json, manga_series(source_language, target_language))",
    )
    .eq("id", job.page_id)
    .single();

  if (pageError || !page) throw pageError || new Error("Página não encontrada");

  const chapter = page.chapters as unknown as {
    context_json: Record<string, unknown>;
    manga_series: { source_language: string; target_language: string };
  };

  const { data: bubbles, error: bubblesError } = await supabase
    .from("speech_bubbles")
    .select(
      "bubble_index, source_text, style_json",
    )
    .eq("page_id", page.id)
    .order("bubble_index");

  if (bubblesError) throw bubblesError;

  const { data: glossary, error: glossaryError } = await supabase
    .from("glossary_terms")
    .select("source_term, preferred_translation, notes")
    .eq(
      "series_id",
      (
        page.chapters as unknown as {
          manga_series: { id?: string };
        }
      ).manga_series.id ?? "",
    );

  if (glossaryError) throw glossaryError;

  await supabase
    .from("pages")
    .update({ status: "translating", error_message: null })
    .eq("id", page.id);

  const result = await translatePageWithGemini({
    sourceLanguage: chapter.manga_series.source_language,
    targetLanguage: chapter.manga_series.target_language,
    chapterContext: chapter.context_json,
    bubbles: (bubbles ?? []).map((bubble) => ({
      bubble_index: bubble.bubble_index,
      source_text: bubble.source_text,
      intent:
        bubble.style_json &&
        typeof bubble.style_json === "object" &&
        "intent" in bubble.style_json
          ? String((bubble.style_json as Record<string, unknown>).intent ?? "")
          : null,
      speaker_hint:
        bubble.style_json &&
        typeof bubble.style_json === "object" &&
        "speaker_hint" in bubble.style_json
          ? String(
              (bubble.style_json as Record<string, unknown>).speaker_hint ?? "",
            )
          : null,
      style_json:
        bubble.style_json &&
        typeof bubble.style_json === "object"
          ? (bubble.style_json as Record<string, unknown>)
          : {},
    })),
    glossary: glossary ?? [],
  });

  const translations = Array.isArray(result.translations)
    ? result.translations
    : [];

  for (const translation of translations) {
    if (!translation || typeof translation !== "object") continue;

    const item = translation as Record<string, unknown>;
    if (typeof item.bubble_index !== "number") continue;

    await supabase
      .from("speech_bubbles")
      .update({
        translated_text:
          typeof item.translated_text === "string"
            ? item.translated_text
            : null,
        translation_notes:
          typeof item.translation_notes === "string"
            ? item.translation_notes
            : null,
        confidence:
          typeof item.confidence === "number" ? item.confidence : null,
      })
      .eq("page_id", page.id)
      .eq("bubble_index", item.bubble_index);
  }

  await supabase
    .from("pages")
    .update({ status: "translated", error_message: null })
    .eq("id", page.id);
}

async function processJob(job: Job) {
  switch (job.job_type) {
    case "process_chapter":
      return processChapter(job);
    case "analyze_page":
      return processAnalysis(job);
    case "translate_page":
      return processTranslation(job);
    case "render_page":
      throw new Error("render_page ainda depende do renderer determinístico");
  }
}

async function run() {
  console.log(`Tradumanga worker iniciado: ${workerId}`);

  while (true) {
    const job = await claimJob();

    if (!job) {
      await sleep(2000);
      continue;
    }

    console.log(
      JSON.stringify({
        event: "job_claimed",
        worker_id: workerId,
        job_id: job.id,
        job_type: job.job_type,
        page_id: job.page_id,
        chapter_id: job.chapter_id,
        attempt: job.attempts,
      }),
    );

    try {
      await processJob(job);
      await completeJob(job, { worker_id: workerId });
      console.log(
        JSON.stringify({
          event: "job_completed",
          worker_id: workerId,
          job_id: job.id,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown worker error";

      console.error(
        JSON.stringify({
          event: "job_failed",
          worker_id: workerId,
          job_id: job.id,
          error: message,
        }),
      );

      await failJob(job, message);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
