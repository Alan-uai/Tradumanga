import { GoogleGenAI } from "@google/genai";

type GeminiJson = Record<string, unknown>;

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

function getModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

export async function analyzePageWithGemini(input: {
  imageBase64: string;
  mimeType: string;
}): Promise<GeminiJson> {
  const ai = getClient();

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

  const result = await ai.models.generateContent({
    model: getModel(),
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

  return parseJson(result.text || "{}");
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
  const ai = getClient();

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

  const result = await ai.models.generateContent({
    model: getModel(),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });

  return parseJson(result.text || "{}");
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
  const ai = getClient();

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

  const result = await ai.models.generateContent({
    model: getModel(),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });

  return parseJson(result.text || "{}");
}
