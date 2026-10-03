import { GoogleGenAI } from "@google/genai";

type GeminiJson = Record<string, unknown>;

export const GEMINI_MODEL_FALLBACKS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
] as const;

function parseJson(text: string): GeminiJson {
  const normalized = text
    .trim()
    .replace(/^\u0060\u0060\u0060json\s*/i, "")
    .replace(/^\u0060\u0060\u0060\s*/i, "")
    .replace(/\s*\u0060\u0060\u0060$/, "");

  return JSON.parse(normalized);
}

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY não configurada");
  return new GoogleGenAI({ apiKey: key });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_MESSAGE = /(unavailable|resource[_ ]exhausted|overloaded|rate limit|too many requests|internal (?:server )?error|temporarily unavailable|try again later|quota exceeded)/i;
const NETWORK_MESSAGE = /(econnreset|econnrefused|etimedout|eai_again|socket hang up|network error|fetch failed|aborted)/i;

export function isRetryableGeminiError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) return true;
  if (typeof status === "string") {
    const numeric = Number(status);
    if (Number.isFinite(numeric) && RETRYABLE_STATUS_CODES.has(numeric)) return true;
    if (RETRYABLE_MESSAGE.test(status)) return true;
  }
  const message = getErrorMessage(error);
  if (/"code"\s*:\s*(\d+)/.test(message)) {
    const code = Number(message.match(/"code"\s*:\s*(\d+)/)?.[1]);
    if (RETRYABLE_STATUS_CODES.has(code)) return true;
  }
  return RETRYABLE_MESSAGE.test(message) || NETWORK_MESSAGE.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 4000;

function backoffDelay(attempt: number) {
  const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return backoff + Math.floor(Math.random() * 300);
}

async function generateJson(
  operation: string,
  request: Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">,
): Promise<GeminiJson> {
  const ai = getClient();
  let lastError: unknown = null;
  let lastRetryable = false;

  for (const model of GEMINI_MODEL_FALLBACKS) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const result = await ai.models.generateContent({ ...request, model });
        const parsed = parseJson(result.text || "{}");

        console.info(JSON.stringify({
          event: "gemini_success",
          operation,
          model,
          attempt,
        }));

        return parsed;
      } catch (error) {
        lastError = error;
        const invalidJson = error instanceof SyntaxError;
        const retryable = invalidJson ? false : isRetryableGeminiError(error);
        lastRetryable = retryable;
        const finalAttempt = attempt >= MAX_ATTEMPTS_PER_MODEL - 1;

        console.warn(JSON.stringify({
          event: "gemini_model_failed",
          operation,
          model,
          attempt,
          kind: invalidJson ? "invalid_json" : "api",
          retryable,
          error: getErrorMessage(error),
        }));

        if (!retryable || finalAttempt) break;
        const delayMs = backoffDelay(attempt);
        console.warn(JSON.stringify({ event: "gemini_retrying", operation, model, attempt: attempt + 1, delayMs }));
        await sleep(delayMs);
      }
    }
  }

  console.error(JSON.stringify({
    event: "gemini_exhausted",
    operation,
    retryable: lastRetryable,
    error: getErrorMessage(lastError),
  }));

  throw new Error(
    `Gemini indisponível após tentar todos os modelos (${GEMINI_MODEL_FALLBACKS.join(", ")}). ${lastRetryable ? "Erro transitório: " : "Último erro: "}${getErrorMessage(lastError)}`,
  );
}

export async function analyzePageWithGemini(input: {
  imageBase64: string;
  mimeType: string;
}): Promise<GeminiJson> {
  const prompt = `Você é o motor de visão e OCR do Tradumanga.
Analise esta página de mangá/manhwa para preparar uma tradução posterior.

IMPORTANTE:
- NÃO traduza os diálogos nesta etapa.
- NÃO invente texto.
- Identifique somente texto realmente visível.
- Preserve a ordem e a identidade dos balões.
- Descreva a cena e os elementos necessários para que outra etapa compreenda o contexto.
- Identifique texto vertical/horizontal, onomatopeias, caixas de narração e falas.
- Forneça polígonos/bounding boxes em coordenadas relativas à imagem quando possível.

Retorne SOMENTE JSON válido no formato:
{
  "story_context": "resumo factual da cena",
  "visual_context": "descrição dos elementos visuais relevantes",
  "bubbles": [
    {
      "bubble_index": 0,
      "polygon": [{"x":0,"y":0}],
      "bbox": {"x":0,"y":0,"width":0,"height":0},
      "source_text": "texto visível",
      "intent": "intenção/ato de fala",
      "speaker_hint": "identificação contextual, se possível",
      "confidence": 0.0,
      "style_json": {
        "orientation": "horizontal",
        "text_type": "dialogue"
      }
    }
  ],
  "warnings": []
}`;

  return generateJson("analyze_page", {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: input.mimeType || "image/jpeg",
              data: input.imageBase64.replace(/^data:[^,]+,/, ""),
            },
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });
}

export async function buildChapterContext(input: {
  title: string;
  analyses: Array<{
    page_number: number;
    story_context?: string | null;
    visual_context?: string | null;
    bubbles?: unknown;
  }>;
}): Promise<GeminiJson> {
  const prompt = `Você é o Context Engine do Tradumanga.
Consolide o contexto narrativo deste capítulo para uma etapa posterior de tradução.

Não traduza os diálogos.
Não invente acontecimentos que não estejam sustentados pelas análises.
Resolva, quando possível, continuidade entre páginas, personagens, relações, nomes e termos recorrentes.
Retorne SOMENTE JSON válido:

{
  "summary": "resumo factual e útil do capítulo",
  "characters": [{"name": "", "role": "", "notes": ""}],
  "relationships": [{"from": "", "to": "", "relationship": ""}],
  "terminology": [{"source_term": "", "meaning": "", "preferred_translation_hint": ""}],
  "events": ["..."],
  "translation_guidance": ["..."]
}

Título: ${input.title}

Análises:
${JSON.stringify(input.analyses)}`;

  return generateJson("build_chapter_context", {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });
}

export async function translatePageWithGemini(input: {
  sourceLanguage: string;
  targetLanguage: string;
  chapterContext: GeminiJson;
  bubbles: Array<{
    bubble_index: number;
    source_text: string | null;
    intent?: string | null;
    speaker_hint?: string | null;
    style_json?: GeminiJson;
  }>;
  glossary: Array<{
    source_term: string;
    preferred_translation: string;
    notes?: string | null;
  }>;
}): Promise<GeminiJson> {
  const prompt = `Você é o tradutor contextual do Tradumanga.
Traduza somente os textos fornecidos, do idioma de origem para pt-BR.

A tradução deve considerar:
- contexto narrativo do capítulo;
- intenção da fala;
- relação entre personagens;
- registro e personalidade;
- naturalidade de português brasileiro;
- continuidade terminológica;
- glossário;
- comprimento razoável para caber no balão.

Não invente falas.
Não remova informação.
Não explique a tradução fora do JSON.
Não altere bubble_index.

Retorne SOMENTE JSON válido:
{
  "translations": [
    {
      "bubble_index": 0,
      "translated_text": "",
      "translation_notes": "",
      "confidence": 0.0
    }
  ]
}

Idioma de origem: ${input.sourceLanguage}
Idioma de destino: ${input.targetLanguage}

Contexto do capítulo:
${JSON.stringify(input.chapterContext)}

Glossário:
${JSON.stringify(input.glossary)}

Balões:
${JSON.stringify(input.bubbles)}`;

  return generateJson("translate_page", {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });
}
