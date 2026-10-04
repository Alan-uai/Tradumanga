import sharp from "sharp";

export type PageLayerBubble = {
  bubble_index?: number;
  polygon: unknown;
  bbox: unknown;
  source_text: string | null;
  translated_text: string | null;
  style_json: Record<string, unknown> | null;
};

type Point = { x: number; y: number };
type Geometry = { x: number; y: number; width: number; height: number; polygon: Point[] };

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function point(value: unknown, width: number, height: number): Point | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clamp(Math.abs(x) <= 1.01 ? x * width : x, 0, width - 1),
    y: clamp(Math.abs(y) <= 1.01 ? y * height : y, 0, height - 1),
  };
}

function geometry(bubble: PageLayerBubble, width: number, height: number): Geometry {
  const polygon = Array.isArray(bubble.polygon)
    ? bubble.polygon.map((p) => point(p, width, height)).filter(Boolean) as Point[]
    : [];

  const bbox = bubble.bbox && typeof bubble.bbox === "object"
    ? bubble.bbox as Record<string, unknown>
    : {};

  if (polygon.length >= 3) {
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    const x = Math.floor(Math.min(...xs));
    const y = Math.floor(Math.min(...ys));
    const right = Math.ceil(Math.max(...xs));
    const bottom = Math.ceil(Math.max(...ys));
    return {
      x,
      y,
      width: Math.max(1, right - x + 1),
      height: Math.max(1, bottom - y + 1),
      polygon,
    };
  }

  const rawX = Number(bbox.x ?? 0);
  const rawY = Number(bbox.y ?? 0);
  const rawW = Number(bbox.width ?? 0);
  const rawH = Number(bbox.height ?? 0);
  const x = clamp(Math.floor(Math.abs(rawX) <= 1.01 ? rawX * width : rawX), 0, width - 1);
  const y = clamp(Math.floor(Math.abs(rawY) <= 1.01 ? rawY * height : rawY), 0, height - 1);
  const w = Math.max(1, Math.ceil(Math.abs(rawW) <= 1.01 ? rawW * width : rawW));
  const h = Math.max(1, Math.ceil(Math.abs(rawH) <= 1.01 ? rawH * height : rawH));
  const right = clamp(x + w - 1, x, width - 1);
  const bottom = clamp(y + h - 1, y, height - 1);

  return {
    x,
    y,
    width: Math.max(1, right - x + 1),
    height: Math.max(1, bottom - y + 1),
    polygon: [
      { x, y },
      { x: right, y },
      { x: right, y: bottom },
      { x, y: bottom },
    ],
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function color(value: unknown, fallback = "#ffffff") {
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i);
  return match ? value.trim() : fallback;
}

function textType(style: Record<string, unknown> | null) {
  return String(style?.text_type ?? "dialogue").toLowerCase();
}

function eligible(bubble: PageLayerBubble) {
  const source = bubble.source_text?.trim();
  const translated = bubble.translated_text?.trim();
  if (!translated) return false;
  if (source && source.localeCompare(translated, undefined, { sensitivity: "base" }) === 0) return false;
  return !["title", "logo", "watermark", "credit"].includes(textType(bubble.style_json));
}

function polygonSvg(points: Point[], fill: string, width: number, height: number) {
  const coords = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><polygon points="${coords}" fill="${escapeXml(fill)}"/></svg>`,
  );
}

function fontSizeFor(text: string, g: Geometry, style: Record<string, unknown> | null) {
  const explicit = Number(style?.font_size ?? style?.fontSize ?? 0);
  if (Number.isFinite(explicit) && explicit >= 8 && explicit <= 256) return explicit;

  const chars = Math.max(1, text.replace(/\s+/g, "").length);
  const lines = Math.max(1, text.split(/\n+/).length);
  return Math.max(
    10,
    Math.min(
      72,
      Math.floor(
        Math.min(
          (g.height / lines) * 0.72,
          (g.width / Math.max(1, Math.min(chars, 22))) * 1.45,
        ),
      ),
    ),
  );
}

async function textLayer(text: string, g: Geometry, style: Record<string, unknown> | null) {
  const alignValue = String(style?.text_align ?? "center").toLowerCase();
  const align = alignValue === "left" ? "left" : alignValue === "right" ? "right" : "center";
  const font = typeof style?.font_family === "string"
    ? style.font_family
    : typeof style?.fontFamily === "string"
      ? style.fontFamily
      : "sans";
  const size = fontSizeFor(text, g, style);

  const rendered = await sharp({
    text: {
      text,
      font: `${font} ${size}`,
      width: g.width,
      height: g.height,
      align,
      rgba: true,
      wrap: "word-char",
      spacing: Number(style?.line_spacing ?? 2),
    },
  }).png().toBuffer();

  return rendered;
}

async function emptyTransparent(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
}

export async function renderPageLayers(original: Buffer, bubbles: PageLayerBubble[]) {
  const meta = await sharp(original).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("Imagem original inválida.");

  const active = bubbles
    .map((bubble, index) => ({ bubble, index }))
    .filter(({ bubble }) => eligible(bubble));

  let clean = await sharp(original, { failOn: "warning" }).png().toBuffer();
  const maskParts: Buffer[] = [];
  const textLayers: Array<{
    bubbleIndex: number;
    buffer: Buffer;
    geometry: Geometry;
  }> = [];
  const manifest: Array<Record<string, unknown>> = [];

  for (const { bubble, index } of active) {
    const g = geometry(bubble, width, height);
    const style = bubble.style_json ?? {};
    const background = color(style.background_color ?? style.backgroundColor, "#ffffff");

    // The source artwork remains immutable. Only the exact authorized text
    // polygon is replaced by the bubble/background color.
    clean = await sharp(clean, { failOn: "warning" })
      .composite([{ input: polygonSvg(g.polygon, background, width, height), left: 0, top: 0 }])
      .png()
      .toBuffer();

    maskParts.push(polygonSvg(g.polygon, "#ffffff", width, height));

    const text = await textLayer(bubble.translated_text!.trim(), g, style);
    textLayers.push({ bubbleIndex: Number(bubble.bubble_index ?? index), buffer: text, geometry: g });

    manifest.push({
      bubble_index: Number(bubble.bubble_index ?? index),
      type: textType(style),
      source_text: bubble.source_text,
      translated_text: bubble.translated_text,
      bbox: { x: g.x, y: g.y, width: g.width, height: g.height },
      polygon: g.polygon,
      style,
      renderer: "sharp-text-layer-v1",
    });
  }

  const mask = maskParts.length
    ? Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g>${maskParts
          .map((p) => p.toString("utf8").match(/<polygon[^>]+>/)?.[0] ?? "")
          .join("")}</g></svg>`,
      )
    : await emptyTransparent(width, height);

  let translated = clean;
  for (const layer of textLayers) {
    translated = await sharp(translated, { failOn: "warning" })
      .composite([{
        input: layer.buffer,
        left: layer.geometry.x,
        top: layer.geometry.y,
        blend: "over",
      }])
      .png()
      .toBuffer();
  }

  const normalizedMask = await sharp(mask)
    .resize({ width, height, fit: "fill" })
    .png()
    .toBuffer();

  const qa = await inspectRenderedOutput(original, translated, normalizedMask);

  return {
    translated,
    clean,
    mask: normalizedMask,
    textLayers,
    manifest,
    qa: {
      ...qa,
      model: "sharp-layer-renderer",
      renderedBubbles: textLayers.length,
    },
  };
}

async function inspectRenderedOutput(original: Buffer, translated: Buffer, mask: Buffer) {
  const [a, b, m] = await Promise.all([
    sharp(original).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(translated).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(mask).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (
    a.info.width !== b.info.width ||
    a.info.height !== b.info.height ||
    m.info.width !== a.info.width ||
    m.info.height !== a.info.height
  ) {
    throw new Error("QA render: dimensões incompatíveis.");
  }

  let changedInsideMask = 0;
  let changedOutsideMask = 0;

  for (let i = 0, p = 0; i < a.data.length; i += a.info.channels, p++) {
    const changed =
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2];

    if (!changed) continue;
    if (m.data[p] > 0) changedInsideMask++;
    else changedOutsideMask++;
  }

  return {
    passed: changedOutsideMask === 0,
    changedInsideMask,
    changedOutsideMask,
    width: a.info.width,
    height: a.info.height,
  };
}
