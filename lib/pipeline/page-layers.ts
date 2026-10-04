import sharp from "sharp";

export type PageLayerBubble = {
  bubble_index?: number;
  polygon: unknown;
  bbox: unknown;
  source_text: string | null;
  translated_text: string | null;
  style_json: Record<string, unknown> | null;
  lines?: unknown;
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

function textLinePolygons(value: unknown, width: number, height: number): Point[][] {
  if (!Array.isArray(value)) return [];
  const result: Point[][] = [];
  for (const line of value) {
    if (!Array.isArray(line)) continue;
    const points = line.map((p) => point(p, width, height)).filter(Boolean) as Point[];
    if (points.length >= 3) result.push(points);
  }
  return result;
}

function polygonsSvg(polygons: Point[][], fill: string, width: number, height: number) {
  const body = polygons
    .map((points) => `<polygon points="${points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}" fill="${escapeXml(fill)}"/>`)
    .join("");
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
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


type TextStyle = {
  orientation: "horizontal" | "vertical";
  align: "left" | "center" | "right";
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  lineSpacing: number;
  letterSpacing: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  lines?: string[];
};

function styleOf(style: Record<string, unknown> | null, text: string, g: Geometry): TextStyle {
  const orientation = String(style?.orientation ?? style?.direction ?? "horizontal").toLowerCase() === "vertical" ? "vertical" : "horizontal";
  const a = String(style?.text_align ?? style?.alignment ?? "center").toLowerCase();
  const align = a === "left" ? "left" : a === "right" ? "right" : "center";
  const explicit = Number(style?.font_size ?? style?.fontSize ?? style?.detected_font_size ?? 0);
  const rawLines = Array.isArray(style?.lines) ? style!.lines!.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const lineCount = Math.max(1, rawLines.length || text.split(/\n+/).length);
  const chars = Math.max(1, text.replace(/\s+/g, "").length);
  const estimated = Math.floor(Math.min((g.height / lineCount) * 0.78, (g.width / Math.max(1, Math.min(chars, 20))) * 1.55));
  const fontSize = Number.isFinite(explicit) && explicit >= 8 && explicit <= 256 ? explicit : Math.max(10, Math.min(96, estimated));
  const weight = Number(style?.font_weight ?? style?.fontWeight ?? 400);
  return {
    orientation,
    align,
    fontFamily: typeof style?.font_family === "string" ? style.font_family : typeof style?.fontFamily === "string" ? style.fontFamily : "sans",
    fontSize,
    fontWeight: Number.isFinite(weight) ? Math.max(100, Math.min(900, Math.round(weight))) : 400,
    italic: Boolean(style?.italic),
    lineSpacing: Math.max(0.8, Math.min(3, Number(style?.line_spacing ?? style?.lineSpacing ?? 1.2))),
    letterSpacing: Math.max(0, Math.min(20, Number(style?.letter_spacing ?? style?.letterSpacing ?? 0))),
    fill: color(style?.text_color ?? style?.foreground_color ?? style?.fg_color, "#111111"),
    stroke: color(style?.stroke_color ?? style?.outline_color, "#ffffff"),
    strokeWidth: Math.max(0, Math.min(12, Number(style?.stroke_width ?? style?.outline_width ?? 0))),
    opacity: Math.max(0, Math.min(1, Number(style?.opacity ?? 1))),
    lines: rawLines.length ? rawLines : undefined,
  };
}

function splitLines(text: string, style: TextStyle, width: number) {
  if (style.lines?.length) return style.lines;
  const explicit = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit;
  const maxChars = Math.max(1, Math.floor(width / Math.max(6, style.fontSize * 0.58)));
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [text];
}

async function localInpaint(original: Buffer, g: Geometry, cleanPolygons: Point[][]): Promise<Buffer> {
  const crop = await sharp(original)
    .extract({ left: g.x, top: g.y, width: g.width, height: g.height })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const relativePolygons = cleanPolygons.length
    ? cleanPolygons.map((polygon) => polygon.map((p) => ({ x: p.x - g.x, y: p.y - g.y })))
    : [g.polygon.map((p) => ({ x: p.x - g.x, y: p.y - g.y }))];
  const mask = await sharp(polygonsSvg(relativePolygons, "#ffffff", g.width, g.height))
    .greyscale().raw().toBuffer();
  const { data, info } = crop;
  const pixels = Buffer.from(data);
  const known = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    known[y * info.width + x] = mask[y * info.width + x] > 127 ? 0 : 1;
  }
  for (let pass = 0; pass < 18; pass++) {
    const next = Buffer.from(pixels);
    let changed = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const idx = y * info.width + x;
      if (known[idx]) continue;
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
        const ni = ny * info.width + nx;
        if (!known[ni]) continue;
        const p = ni * info.channels;
        sr += pixels[p]; sg += pixels[p + 1]; sb += pixels[p + 2]; sa += info.channels > 3 ? pixels[p + 3] : 255; n++;
      }
      if (!n) continue;
      const p = idx * info.channels;
      next[p] = Math.round(sr / n); next[p + 1] = Math.round(sg / n); next[p + 2] = Math.round(sb / n);
      if (info.channels > 3) next[p + 3] = Math.round(sa / n);
      known[idx] = 1; changed++;
    }
    pixels.set(next);
    if (!changed) break;
  }
  return sharp(pixels, { raw: info }).png().toBuffer();
}

async function textLayer(text: string, g: Geometry, rawStyle: Record<string, unknown> | null) {
  const style = styleOf(rawStyle, text, g);
  const lines = splitLines(text, style, g.width);
  const lineHeight = Math.max(style.fontSize, Math.round(style.fontSize * style.lineSpacing));
  const startY = Math.max(style.fontSize, (g.height - lineHeight * lines.length) / 2 + style.fontSize * 0.82);
  const x = style.align === "left" ? 4 : style.align === "right" ? g.width - 4 : g.width / 2;
  const anchor = style.align === "left" ? "start" : style.align === "right" ? "end" : "middle";
  const attrs = `font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" font-style="${style.italic ? "italic" : "normal"}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}" paint-order="stroke" letter-spacing="${style.letterSpacing}" opacity="${style.opacity}"`;
  let body = "";
  if (style.orientation === "vertical") {
    const chars = [...text.replace(/\s+/g, "")];
    body = `<text x="${g.width / 2}" y="${startY}" text-anchor="middle" ${attrs}>${chars.map((ch, i) => `<tspan x="${g.width / 2}" dy="${i ? lineHeight : 0}">${escapeXml(ch)}</tspan>`).join("")}</text>`;
  } else {
    body = `<text x="${x}" y="${startY}" text-anchor="${anchor}" ${attrs}>${lines.map((line, i) => `<tspan x="${x}" dy="${i ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join("")}</text>`;
  }
  return sharp(Buffer.from(`<svg width="${g.width}" height="${g.height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`)).png().toBuffer();
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
  const cleanLayers: Array<{
    bubbleIndex: number;
    buffer: Buffer;
    geometry: Geometry;
  }> = [];
  const textLayers: Array<{
    bubbleIndex: number;
    buffer: Buffer;
    geometry: Geometry;
  }> = [];
  const manifest: Array<Record<string, unknown>> = [];

  for (const { bubble, index } of active) {
    const g = geometry(bubble, width, height);
    const style = bubble.style_json ?? {};
    const linePolygons = textLinePolygons(bubble.lines ?? style.lines, width, height);

    // Ballons-style block isolation: reconstruct only the authorized text
    // region instead of painting the whole polygon with a guessed background.
    // This keeps bubble borders/artwork outside the text mask untouched.
    const bubbleIndex = Number(bubble.bubble_index ?? index);
    const cleanLayer = await localInpaint(original, g, linePolygons);

    clean = await sharp(clean, { failOn: "warning" })
      .composite([{ input: cleanLayer, left: g.x, top: g.y }])
      .png()
      .toBuffer();

    cleanLayers.push({ bubbleIndex, buffer: cleanLayer, geometry: g });
    maskParts.push(polygonSvg(g.polygon, "#ffffff", width, height));

    const text = await textLayer(bubble.translated_text!.trim(), g, style);
    textLayers.push({ bubbleIndex, buffer: text, geometry: g });

    manifest.push({
      bubble_index: bubbleIndex,
      type: textType(style),
      source_text: bubble.source_text,
      translated_text: bubble.translated_text,
      bbox: { x: g.x, y: g.y, width: g.width, height: g.height },
      polygon: g.polygon,
      text_line_polygons: linePolygons,
      style,
      renderer: "tradumanga-textblock-v2",
      cleaning: "localized-propagation-v1",
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
    cleanLayers,
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
