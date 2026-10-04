import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzePageWithGemini, buildChapterContext, translatePageWithGemini } from "@/lib/pipeline/gemini";
import { ingestChapter, progress, renderTranslatedPage, sha256, actorPrefix } from "@/lib/pipeline/inngest-runtime";

const LIMIT = { scope: "account" as const, key: '"tradumanga-pipeline"', limit: 5 };

async function markChapterError(chapterId: string, message: string) {
  const admin = createAdminClient();
  await admin.from("chapters").update({
    status: "error",
    error_message: message,
    progress_json: { error: message },
  }).eq("id", chapterId);
}

export const processChapter = inngest.createFunction(
  {
    id: "tradumanga-process-chapter",
    triggers: { event: "tradumanga/chapter.process" },
    concurrency: LIMIT,
    singleton: { key: "event.data.chapterId", mode: "skip" },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const original = (event.data as any)?.event?.data as { chapterId?: string } | undefined;
      if (original?.chapterId) await markChapterError(original.chapterId, error.message);
    },
  },
  async ({ event, step }) => {
    const result = await step.run("ingest-chapter", () => ingestChapter(event.data.chapterId));
    if (!result.pageIds.length) throw new Error("Nenhuma página foi criada para o capítulo.");

    await step.sendEvent("fanout-analysis", result.pageIds.map((pageId) => ({
      id: `analyze:${pageId}`,
      name: "tradumanga/page.analyze",
      data: { pageId },
    })));

    return { chapterId: event.data.chapterId, pageCount: result.pageIds.length };
  },
);

export const analyzePage = inngest.createFunction(
  {
    id: "tradumanga-analyze-page",
    triggers: { event: "tradumanga/page.analyze" },
    concurrency: LIMIT,
    singleton: { key: "event.data.pageId", mode: "skip" },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const admin = createAdminClient();
      const original = (event.data as any)?.event?.data as { pageId?: string } | undefined;
      if (original?.pageId) await admin.from("pages").update({ status: "error", error_message: error.message }).eq("id", original.pageId);
    },
  },
  async ({ event, step }) => {
    const pageId = event.data.pageId;
    const analysisResult = await step.run("analyze-with-gemini", async () => {
      const admin = createAdminClient();
      const { data: page, error } = await admin.from("pages").select("id,original_path,chapter_id").eq("id", pageId).single();
      if (error || !page) throw error || new Error("Página não encontrada.");
      const { data: chapter } = await admin.from("chapters").select("title,series_id").eq("id", page.chapter_id).single();
      if (!chapter) throw new Error("Capítulo não encontrado.");
      const { data: series } = await admin.from("manga_series").select("source_language,target_language").eq("id", chapter.series_id).single();
      if (!series) throw new Error("Obra não encontrada.");

      const { data: file, error: fileError } = await admin.storage.from("manga-pages").download(page.original_path);
      if (fileError || !file) throw fileError || new Error("Não foi possível baixar a página original.");
      await admin.from("pages").update({ status: "analyzing", error_message: null }).eq("id", pageId);

      const parsed = await analyzePageWithGemini({
        imageBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
        mimeType: file.type || "image/jpeg",
      });
      const bubbles = Array.isArray(parsed.bubbles) ? parsed.bubbles : [];

      await admin.from("page_analyses").delete().eq("page_id", pageId);
      const { error: analysisError } = await admin.from("page_analyses").insert({
        page_id: pageId,
        model: "gemini-fallback",
        model_version: null,
        source_language: series.source_language,
        target_language: series.target_language,
        story_context: typeof parsed.story_context === "string" ? parsed.story_context : null,
        visual_context: typeof parsed.visual_context === "string" ? parsed.visual_context : null,
        ocr_text: bubbles.map((b:any) => typeof b?.source_text === "string" ? b.source_text : "").filter(Boolean).join("\n"),
        analysis_json: parsed,
      });
      if (analysisError) throw analysisError;

      await admin.from("speech_bubbles").delete().eq("page_id", pageId);
      for (const bubble of bubbles) {
        if (!bubble || typeof bubble !== "object" || typeof bubble.bubble_index !== "number") continue;
        const { error: bubbleError } = await admin.from("speech_bubbles").insert({
          page_id: pageId,
          bubble_index: bubble.bubble_index,
          polygon: Array.isArray(bubble.polygon) ? bubble.polygon : [],
          bbox: bubble.bbox ?? null,
          source_text: typeof bubble.source_text === "string" ? bubble.source_text : null,
          translated_text: null,
          translation_notes: null,
          confidence: typeof bubble.confidence === "number" ? bubble.confidence : null,
          style_json: {
            ...(bubble.style_json && typeof bubble.style_json === "object" ? bubble.style_json : {}),
            intent: typeof bubble.intent === "string" ? bubble.intent : null,
            speaker_hint: typeof bubble.speaker_hint === "string" ? bubble.speaker_hint : null,
          },
        });
        if (bubbleError) throw bubbleError;
      }
      await admin.from("pages").update({ status: "analyzed", error_message: null }).eq("id", pageId);
      return { chapterId: page.chapter_id };
    });

    await step.run("update-progress", () => progress(createAdminClient(), analysisResult.chapterId));

    const contextResult = await step.run("build-context-if-ready", async () => {
      const admin = createAdminClient();
      const { data: chapter, error } = await admin.from("chapters")
        .select("id,title,context_updated_at,series_id").eq("id", analysisResult.chapterId).single();
      if (error || !chapter) throw error || new Error("Capítulo não encontrado.");
      if (chapter.context_updated_at) return { built: false, pageIds: [] as string[] };

      const { data: pages, error: pagesError } = await admin.from("pages")
        .select("id,page_number,status").eq("chapter_id", chapter.id).order("page_number");
      if (pagesError) throw pagesError;
      if (!pages?.length || pages.some((p:any) => p.status !== "analyzed")) return { built: false, pageIds: [] as string[] };

      const analyses = [];
      for (const page of pages) {
        const { data: analysis } = await admin.from("page_analyses")
          .select("story_context,visual_context,analysis_json").eq("page_id", page.id)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (!analysis) return { built: false, pageIds: [] as string[] };
        const json = analysis.analysis_json && typeof analysis.analysis_json === "object" ? analysis.analysis_json as Record<string, unknown> : {};
        analyses.push({ page_number: page.page_number, story_context: analysis.story_context, visual_context: analysis.visual_context, bubbles: json.bubbles ?? [] });
      }

      const context = await buildChapterContext({ title: chapter.title || "Capítulo", analyses });
      const { data: updated, error: updateError } = await admin.from("chapters").update({
        context_text: typeof context.summary === "string" ? context.summary : null,
        context_json: context,
        context_model: "gemini-fallback",
        context_version: "v3",
        context_updated_at: new Date().toISOString(),
        status: "processing",
      }).eq("id", chapter.id).is("context_updated_at", null).select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return { built: false, pageIds: [] as string[] };

      await progress(admin, chapter.id);
      return { built: true, pageIds: pages.map((p:any) => p.id) };
    });

    if (contextResult.built) {
      await step.sendEvent("fanout-translation", contextResult.pageIds.map((id) => ({
        id: `translate:${id}`,
        name: "tradumanga/page.translate",
        data: { pageId: id },
      })));
    }
    return { pageId, contextBuilt: contextResult.built };
  },
);

export const translatePage = inngest.createFunction(
  {
    id: "tradumanga-translate-page",
    triggers: { event: "tradumanga/page.translate" },
    concurrency: LIMIT,
    singleton: { key: "event.data.pageId", mode: "skip" },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const admin = createAdminClient();
      const original = (event.data as any)?.event?.data as { pageId?: string } | undefined;
      if (original?.pageId) await admin.from("pages").update({ status: "error", error_message: error.message }).eq("id", original.pageId);
    },
  },
  async ({ event, step }) => {
    const pageId = event.data.pageId;
    const result = await step.run("translate-with-gemini", async () => {
      const admin = createAdminClient();
      const { data: page, error } = await admin.from("pages").select("id,chapter_id").eq("id", pageId).single();
      if (error || !page) throw error || new Error("Página não encontrada.");
      const { data: chapter } = await admin.from("chapters").select("context_json,series_id").eq("id", page.chapter_id).single();
      if (!chapter) throw new Error("Capítulo não encontrado.");
      const { data: series } = await admin.from("manga_series").select("id,source_language,target_language").eq("id", chapter.series_id).single();
      if (!series) throw new Error("Obra não encontrada.");
      const { data: bubbles, error: be } = await admin.from("speech_bubbles")
        .select("bubble_index,source_text,style_json").eq("page_id", pageId).order("bubble_index");
      if (be) throw be;
      const { data: glossary, error: ge } = await admin.from("glossary_terms")
        .select("source_term,preferred_translation,notes").eq("series_id", series.id);
      if (ge) throw ge;

      await admin.from("pages").update({ status: "translating", error_message: null }).eq("id", pageId);
      const translated = await translatePageWithGemini({
        sourceLanguage: series.source_language,
        targetLanguage: series.target_language,
        chapterContext: (chapter.context_json ?? {}) as Record<string, unknown>,
        bubbles: (bubbles ?? []).map((b:any) => ({
          bubble_index:b.bubble_index, source_text:b.source_text,
          intent:b.style_json?.intent ?? null, speaker_hint:b.style_json?.speaker_hint ?? null,
          style_json:b.style_json && typeof b.style_json==="object" ? b.style_json : {},
        })),
        glossary: glossary ?? [],
      });

      for (const item of Array.isArray(translated.translations) ? translated.translations : []) {
        if (!item || typeof item !== "object" || typeof (item as any).bubble_index !== "number") continue;
        const { error } = await admin.from("speech_bubbles").update({
          translated_text: typeof (item as any).translated_text === "string" ? (item as any).translated_text : null,
          translation_notes: typeof (item as any).translation_notes === "string" ? (item as any).translation_notes : null,
          confidence: typeof (item as any).confidence === "number" ? (item as any).confidence : null,
        }).eq("page_id", pageId).eq("bubble_index", (item as any).bubble_index);
        if (error) throw error;
      }
      await admin.from("pages").update({ status: "translated", error_message: null }).eq("id", pageId);
      await progress(admin, page.chapter_id);
      return { chapterId: page.chapter_id };
    });

    await step.sendEvent("queue-render", { id:`render:${pageId}`, name:"tradumanga/page.render", data:{pageId} });
    return { pageId, chapterId: result.chapterId };
  },
);

export const renderPage = inngest.createFunction(
  {
    id: "tradumanga-render-page",
    triggers: { event: "tradumanga/page.render" },
    concurrency: LIMIT,
    retries: 3,
    onFailure: async ({ event, error }) => {
      const admin = createAdminClient();
      const original = (event.data as any)?.event?.data as { pageId?: string } | undefined;
      if (original?.pageId) await admin.from("pages").update({ status: "error", error_message: error.message }).eq("id", original.pageId);
    },
  },
  async ({ event, step }) => {
    const pageId = event.data.pageId;
    const result = await step.run("render-and-qa", async () => {
      const admin = createAdminClient();
      const { data: page, error } = await admin.from("pages").select("id,chapter_id,page_number,original_path").eq("id", pageId).single();
      if (error || !page) throw error || new Error("Página não encontrada.");
      const { data: chapter } = await admin.from("chapters").select("series_id,chapter_number").eq("id", page.chapter_id).single();
      if (!chapter) throw new Error("Capítulo não encontrado.");
      const { data: series } = await admin.from("manga_series").select("id,owner_id,anonymous_session_id").eq("id", chapter.series_id).single();
      if (!series) throw new Error("Obra não encontrada.");
      const { data: bubbles, error: be } = await admin.from("speech_bubbles")
        .select("polygon,bbox,source_text,translated_text,style_json").eq("page_id", pageId).order("bubble_index");
      if (be) throw be;
      const { data: file, error: fe } = await admin.storage.from("manga-pages").download(page.original_path);
      if (fe || !file) throw fe || new Error("Não foi possível baixar o original.");
      const original = Buffer.from(await file.arrayBuffer());
      await admin.from("pages").update({ status:"rendering",error_message:null }).eq("id",pageId);
      const rendered=await renderTranslatedPage(original,(bubbles??[]).map((b:any)=>({
        bubble_index:b.bubble_index,
        polygon:b.polygon,
        bbox:b.bbox,
        source_text:b.source_text,
        translated_text:b.translated_text,
        style_json:b.style_json,
      })));
      if(!rendered.qa.passed) throw new Error(`QA de camadas falhou: ${rendered.qa.changedOutsideMask} pixels alterados fora das regiões autorizadas.`);

      const prefix=actorPrefix(series);
      const stem=`${String(page.page_number).padStart(4,"0")}`;
      const translatedPath=`${prefix}/${series.id}/${chapter.chapter_number}/translated/${stem}.png`;
      const cleanPath=`${prefix}/${series.id}/${chapter.chapter_number}/clean/${stem}.png`;
      const maskPath=`${prefix}/${series.id}/${chapter.chapter_number}/masks/${stem}.png`;
      const manifestPath=`${prefix}/${series.id}/${chapter.chapter_number}/layers/${stem}.json`;

      const {error:tu}=await admin.storage.from("manga-pages").upload(translatedPath,rendered.translated,{contentType:"image/png",upsert:true});if(tu)throw tu;
      const {error:cu}=await admin.storage.from("manga-pages").upload(cleanPath,rendered.clean,{contentType:"image/png",upsert:true});if(cu)throw cu;
      const {error:mu}=await admin.storage.from("manga-pages").upload(maskPath,rendered.mask,{contentType:"image/png",upsert:true});if(mu)throw mu;

      const manifest=rendered.manifest.map((item:any)=>{
        const bubbleIndex=Number(item.bubble_index);
        return {
          ...item,
          clean_layer_path:cleanPath,
          text_layer_path:`${prefix}/${series.id}/${chapter.chapter_number}/layers/${stem}/text-${String(bubbleIndex).padStart(4,"0")}.png`,
        };
      });
      const manifestBuffer=Buffer.from(JSON.stringify({
        version:"page-layers-v1",
        page_id:pageId,
        width:rendered.qa.width,
        height:rendered.qa.height,
        original_sha256:sha256(original),
        layers:manifest,
      },null,2));
      const {error:manu}=await admin.storage.from("manga-pages").upload(manifestPath,manifestBuffer,{contentType:"application/json",upsert:true});if(manu)throw manu;

      for(const layer of rendered.textLayers){
        const item=manifest.find((entry:any)=>Number(entry.bubble_index)===layer.bubbleIndex);
        if(!item) continue;
        const textPath=String(item.text_layer_path);
        const {error:te}=await admin.storage.from("manga-pages").upload(textPath,layer.buffer,{contentType:"image/png",upsert:true});if(te)throw te;
        const {error:be}=await admin.from("speech_bubbles").update({
          clean_layer_path:cleanPath,
          text_layer_path:textPath,
          layer_status:"rendered",
        }).eq("page_id",pageId).eq("bubble_index",layer.bubbleIndex);
        if(be)throw be;
      }

      const {error:pu}=await admin.from("pages").update({
        translated_path:translatedPath,
        clean_path:cleanPath,
        layer_manifest_path:manifestPath,
        translated_sha256:sha256(rendered.translated),
        authorized_mask_path:maskPath,
        layer_render_version:"v1",
        render_version:"v4-layers",
        status:"ready",
        error_message:null,
      }).eq("id",pageId);if(pu)throw pu;
      await progress(admin,page.chapter_id);
      const {data:all,error:ae}=await admin.from("pages").select("status").eq("chapter_id",page.chapter_id);if(ae)throw ae;
      if((all??[]).length && (all??[]).every((p:any)=>p.status==="ready")){
        await admin.from("chapters").update({status:"ready",error_message:null,progress_json:{download:100,analysis:100,context:100,translation:100,render:100,qa:100,overall:100,contextReady:true}}).eq("id",page.chapter_id);
        await admin.from("manga_series").update({status:"ready"}).eq("id",chapter.series_id);
      }
      return {chapterId:page.chapter_id,qa:rendered.qa};
    });
    return {pageId,chapterId:result.chapterId,qa:result.qa};
  },
);


export const reconcileUntranslatedPages = inngest.createFunction(
  {
    id: "tradumanga-reconcile-untranslated-pages",
    triggers: { cron: "*/5 * * * *" },
    concurrency: { scope: "account" as const, key: '"tradumanga-reconcile"', limit: 1 },
    retries: 2,
  },
  async ({ step }) => {
    const pageIds = await step.run("find-untranslated-pages", async () => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("pages")
        .select("id,chapters!inner(context_updated_at)")
        .is("translated_path", null)
        .eq("status", "analyzed")
        .not("chapters.context_updated_at", "is", null)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return (data ?? []).map((page: any) => page.id as string);
    });

    if (!pageIds.length) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-untranslated-pages",
      pageIds.map((pageId) => ({
        id: `translate:${pageId}`,
        name: "tradumanga/page.translate",
        data: {
          pageId,
          source: "inngest-untranslated-page-reconciler",
        },
      })),
    );

    return { dispatched: pageIds.length };
  },
);

export const functions = [processChapter, analyzePage, translatePage, renderPage, reconcileUntranslatedPages];
