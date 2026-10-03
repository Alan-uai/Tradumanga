import json, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

def clamp(v, lo, hi):
    return max(lo, min(hi, int(round(v))))

def polygon_points(item, width, height):
    polygon = item.get("polygon") or []
    points = []
    for p in polygon:
        if not isinstance(p, dict):
            continue
        x, y = p.get("x"), p.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            # Gemini may return normalized coordinates or pixel coordinates.
            px = x * width if 0 <= x <= 1 else x
            py = y * height if 0 <= y <= 1 else y
            points.append((clamp(px, 0, width - 1), clamp(py, 0, height - 1)))
    if len(points) >= 3:
        return points
    bbox = item.get("bbox") or {}
    x = bbox.get("x", 0)
    y = bbox.get("y", 0)
    w = bbox.get("width", 0)
    h = bbox.get("height", 0)
    if max(abs(float(x or 0)), abs(float(y or 0)), abs(float(w or 0)), abs(float(h or 0))) <= 1:
        x, y, w, h = x * width, y * height, w * width, h * height
    return [
        (clamp(x, 0, width - 1), clamp(y, 0, height - 1)),
        (clamp(x + w, 0, width - 1), clamp(y, 0, height - 1)),
        (clamp(x + w, 0, width - 1), clamp(y + h, 0, height - 1)),
        (clamp(x, 0, width - 1), clamp(y + h, 0, height - 1)),
    ]

def bbox_for(points, width, height):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, x1 = max(0, min(xs)), min(width - 1, max(xs))
    y0, y1 = max(0, min(ys)), min(height - 1, max(ys))
    return x0, y0, max(1, x1 - x0 + 1), max(1, y1 - y0 + 1)

def font_for(style, size):
    bold = bool(style.get("bold")) or str(style.get("weight", "")).lower() in {"bold", "700", "800", "900"}
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=max(8, size))
    return ImageFont.load_default()

def wrap_lines(draw, text, font, max_width):
    words = text.replace("\\n", " ").split()
    if not words:
        return []
    lines, current = [], words[0]
    for word in words[1:]:
        candidate = current + " " + word
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines

def fit_text(draw, text, max_width, max_height, style):
    base = max(10, min(64, int(max_height * 0.22)))
    for size in range(base, 7, -1):
        font = font_for(style, size)
        lines = wrap_lines(draw, text, font, max_width)
        line_height = max(1, font.getbbox("Ag")[3] - font.getbbox("Ag")[1])
        total = len(lines) * line_height + max(0, len(lines) - 1) * int(size * 0.18)
        if total <= max_height and all(draw.textbbox((0, 0), line, font=font)[2] <= max_width for line in lines):
            return font, lines, line_height
    font = font_for(style, 8)
    return font, wrap_lines(draw, text, font, max_width), 10

def render(original_path, output_path, mask_path, bubbles):
    image = cv2.imread(str(original_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Não foi possível abrir a imagem: {original_path}")
    height, width = image.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)

    valid = []
    for item in bubbles:
        if not isinstance(item, dict):
            continue
        points = polygon_points(item, width, height)
        if len(points) < 3:
            continue
        cv2.fillPoly(mask, [np.array(points, dtype=np.int32)], 255)
        x, y, w, h = bbox_for(points, width, height)
        valid.append((item, (x, y, w, h)))

    # Deterministic local inpainting. Pixels outside the authorized mask are never written.
    if np.any(mask):
        image = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    draw = ImageDraw.Draw(pil)

    for item, (x, y, w, h) in valid:
        text = item.get("translated_text")
        if not isinstance(text, str) or not text.strip():
            continue
        style = item.get("style_json") if isinstance(item.get("style_json"), dict) else {}
        pad = max(4, int(min(w, h) * 0.08))
        orientation = str(style.get("orientation", "horizontal")).lower()
        color = (20, 20, 24)
        if style.get("text_type") == "narration":
            color = (30, 30, 30)

        if orientation == "vertical":
            size = max(10, min(42, int(min(w, h) * 0.16)))
            font = font_for(style, size)
            chars = [c for c in text.replace(" ", "") if c != "\\n"]
            line_h = max(1, font.getbbox("あ")[3] - font.getbbox("あ")[1])
            total_h = line_h * len(chars)
            cy = y + max(0, (h - total_h) // 2)
            cx = x + max(0, (w - size) // 2)
            for char in chars:
                draw.text((cx, cy), char, font=font, fill=color, stroke_width=0)
                cy += line_h
        else:
            font, lines, line_h = fit_text(draw, text.strip(), max(1, w - 2 * pad), max(1, h - 2 * pad), style)
            total_h = len(lines) * line_h + max(0, len(lines) - 1) * int(font.size * 0.18)
            cy = y + max(0, (h - total_h) // 2)
            align = str(style.get("align", "center")).lower()
            for line in lines:
                box = draw.textbbox((0, 0), line, font=font)
                tw = box[2] - box[0]
                if align == "left":
                    cx = x + pad
                elif align == "right":
                    cx = x + w - pad - tw
                else:
                    cx = x + (w - tw) // 2
                draw.text((cx, cy), line, font=font, fill=color)
                cy += line_h + int(font.size * 0.18)

    result = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    cv2.imwrite(str(output_path), result, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    cv2.imwrite(str(mask_path), mask, [cv2.IMWRITE_PNG_COMPRESSION, 9])

def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: render_page.py original output mask bubbles.json")
    original, output, mask, bubbles_file = map(Path, sys.argv[1:])
    bubbles = json.loads(bubbles_file.read_text(encoding="utf-8"))
    render(original, output, mask, bubbles)

if __name__ == "__main__":
    main()
