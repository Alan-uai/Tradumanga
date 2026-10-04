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
- Priorize texto narrativo, caixas de texto e falas que façam parte da obra.
- NÃO trate como balão de fala textos de scanlation, marcas d'água, logos, URLs, créditos, banners, cabeçalhos, rodapés ou publicidade do site.
- Não crie um bounding box gigante para uma área de créditos ou marca d'água.
- Para cada fala, delimite somente a região ocupada pelo texto dentro do balão; não inclua a página inteira nem uma área muito maior que o texto.
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


export type GeminiImageEdit = {
  translated_text: string;
  source_text?: string | null;
  bubble_index: number;
  bbox?: unknown;
};

export async function editPageWithNanoBanana2(input: {
  image: Buffer;
  mimeType: string;
  width: number;
  height: number;
  edits: GeminiImageEdit[];
}): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY não configurada");

  const edits = input.edits.filter((item) => item.translated_text.trim());
  const prompt = [
    "Você é o editor visual do Tradumanga usando Nano Banana 2.",
    "Edite a página de mangá/manhwa fornecida.",
    "",
    "OBJETIVO:",
    "Substituir somente os textos das regiões de fala/narração indicadas pelas traduções fornecidas.",
    "Remova completamente o texto original dessas regiões antes de inserir o português.",
    "Use português brasileiro natural e exatamente o texto de tradução fornecido.",
    "",
    "PRESERVAÇÃO OBRIGATÓRIA:",
    "- Preserve personagens, rostos, cabelo, roupas, cenários, linhas, painéis, cores, iluminação e composição.",
    "- Não redesenhe a página.",
    "- Não altere elementos que não sejam os textos indicados.",
    "- Não traduza logos, marcas d'água, créditos, URLs ou publicidade.",
    "- Não adicione texto novo.",
    "- Não corte, estique ou mude a proporção da página.",
    "- Mantenha a resolução e o enquadramento da imagem de entrada tanto quanto a API permitir.",
    "- O texto inserido deve parecer naturalmente integrado ao balão/caixa original, respeitando orientação, tamanho e estilo visual.",
    "",
    "REGIÕES E TRADUÇÕES:",
    JSON.stringify(edits),
    "",
    "IMPORTANTE: as coordenadas são referências para localizar as regiões; use também a própria imagem para identificar visualmente os balões.",
  ].join("\n");

  const body = {
    model: "gemini-3.1-flash-image",
    input: [
      {
        type: "image",
        mime_type: input.mimeType || "image/png",
        data: input.image.toString("base64"),
      },
      { type: "text", text: prompt },
    ],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      image_size: "2K",
    },
  };

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Nano Banana 2 HTTP ${response.status}: ${detail.slice(0, 1200)}`);
  }

  const result = await response.json() as {
    output_image?: { data?: string | null };
    output?: Array<{ type?: string; data?: string; mime_type?: string }>;
  };

  const encoded = result.output_image?.data
    ?? result.output?.find((item) => item.type === "image" && item.data)?.data;

  if (!encoded) throw new Error("Nano Banana 2 não retornou uma imagem.");
  return Buffer.from(encoded, "base64");
}



export async function editPageWithQwenImageEditFallback(input: {
  image: Buffer;
  mimeType: string;
  width: number;
  height: number;
  edits: GeminiImageEdit[];
}): Promise<Buffer> {
  const endpoint = process.env.QWEN_IMAGE_EDIT_URL?.trim();
  if (!endpoint) {
    throw new Error(
      "QWEN_IMAGE_EDIT_URL não configurada. O fallback gratuito usa Qwen-Image-Edit-2511 auto-hospedado.",
    );
  }

  const edits = input.edits.filter((item) => item.translated_text.trim());
  const prompt = [
    "Você é o editor visual do Tradumanga usando Qwen-Image-Edit-2511.",
    "Edite a página de mangá/manhwa fornecida.",
    "",
    "OBJETIVO:",
    "Substitua somente os textos das regiões de fala/narração indicadas.",
    "Remova completamente o texto original antes de inserir o português.",
    "Use exatamente as traduções fornecidas, sem inventar texto.",
    "",
    "PRESERVAÇÃO OBRIGATÓRIA:",
    "- Preserve personagens, rostos, cabelo, roupas, cenários, linhas, painéis, cores, iluminação e composição.",
    "- Não redesenhe a página.",
    "- Não altere regiões fora das áreas de texto indicadas.",
    "- Não traduza logos, marcas d'água, créditos, URLs, publicidade ou nomes de sites.",
    "- Não adicione texto que não esteja nas traduções.",
    "- Não corte, estique ou altere a proporção da página.",
    "- Preserve a orientação vertical/horizontal e o estilo visual original dos balões.",
    "",
    "REGIÕES E TRADUÇÕES:",
    JSON.stringify(edits),
    "",
    "As coordenadas são referências para localizar as regiões; use também a própria imagem para identificar visualmente os balões.",
  ].join("\n");

  const form = new FormData();
  form.append("prompt", prompt);
  const imageBytes = new Uint8Array(input.image.byteLength);
  imageBytes.set(input.image);
  form.append("images", new Blob([imageBytes.buffer], { type: input.mimeType || "image/png" }), "page.png");
  form.append("response_format", "url");
  form.append("profile", process.env.QWEN_IMAGE_EDIT_PROFILE?.trim() || "qwen_edit_2511_gguf_q4");

  const token = process.env.QWEN_IMAGE_EDIT_TOKEN?.trim();
  const headers:Record<string,string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(endpoint.replace(/\/$/, "") + "/v1/image/edit", {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(Number(process.env.QWEN_IMAGE_EDIT_TIMEOUT_MS || 300000)),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Qwen Image Edit HTTP ${response.status}: ${detail.slice(0, 1200)}`);
  }

  const result = await response.json() as {
    image_url?: string;
    output_url?: string;
    image_base64?: string;
    output_image?: string;
  };

  const encoded = result.image_base64 || result.output_image;
  if (encoded) return Buffer.from(encoded.replace(/^data:[^,]+,/, ""), "base64");

  const imageUrl = result.image_url || result.output_url;
  if (!imageUrl) throw new Error("Qwen Image Edit não retornou URL/base64 de imagem.");

  const absoluteUrl = new URL(imageUrl, endpoint).toString();
  const imageResponse = await fetch(absoluteUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(Number(process.env.QWEN_IMAGE_EDIT_TIMEOUT_MS || 300000)),
  });
  if (!imageResponse.ok) {
    const detail = await imageResponse.text().catch(() => "");
    throw new Error(`Qwen Image Edit output HTTP ${imageResponse.status}: ${detail.slice(0, 1000)}`);
  }

  return Buffer.from(await imageResponse.arrayBuffer());
}
