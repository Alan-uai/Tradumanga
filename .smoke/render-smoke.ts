import sharp from "sharp";
import { renderTranslatedPage } from "@/lib/pipeline/inngest-runtime";

function bubble(polygon: any[], text: string, extra: Record<string, unknown> = {}) {
  return { polygon, bbox: null, translated_text: text, style_json: { orientation: "horizontal", ...(extra as any) } };
}

async function main() {
  const original = await sharp({
    create: { width: 400, height: 600, channels: 3, background: { r: 240, g: 240, b: 235 } },
  }).jpeg().toBuffer();

  const cases: Array<{ name: string; bubbles: any[] }> = [
    { name: "patch 3x3 (median 5)", bubbles: [bubble([{ x: 10, y: 10 }, { x: 13, y: 10 }, { x: 13, y: 13 }, { x: 10, y: 13 }], "Oi")] },
    { name: "balão grande, texto curto (mask > text bbox)", bubbles: [bubble([{ x: 50, y: 100 }, { x: 250, y: 100 }, { x: 250, y: 200 }, { x: 50, y: 200 }], "Tudo bem?")] },
    { name: "texto longo em balão médio", bubbles: [bubble([{ x: 20, y: 300 }, { x: 180, y: 300 }, { x: 180, y: 420 }, { x: 20, y: 420 }], "Uma frase bem longa para forçar quebra de linha e teste de overflow da camada de texto dentro do balão.") ] },
    { name: "balão colado na borda direita", bubbles: [bubble([{ x: 392, y: 500 }, { x: 400, y: 500 }, { x: 400, y: 540 }, { x: 392, y: 540 }], "Ok")] },
    { name: "sem balões traduzidos", bubbles: [] },
    { name: "só balão sem texto", bubbles: [bubble([{ x: 50, y: 500 }, { x: 250, y: 500 }, { x: 250, y: 560 }, { x: 50, y: 560 }], "   ")] },
    { name: "bbox relativo (0..1)", bubbles: [{ polygon: [], bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, translated_text: "Rel", style_json: { orientation: "vertical" } }] },
    { name: "fonte inexistente (fallback)", bubbles: [bubble([{ x: 50, y: 440 }, { x: 250, y: 440 }, { x: 250, y: 500 }, { x: 50, y: 500 }], "Fallback", { font: "fonte-inexistente-xyz" })] },
    { name: "polígono fora dos limites", bubbles: [bubble([{ x: -50, y: -50 }, { x: 9999, y: -50 }, { x: 9999, y: 9999 }, { x: -50, y: 9999 }], "Fora")] },
    { name: "coordenadas relativas 0..1 no polígono", bubbles: [bubble([{ x: 0.05, y: 0.05 }, { x: 0.5, y: 0.05 }, { x: 0.5, y: 0.15 }, { x: 0.05, y: 0.15 }], "Relativo")] },
    { name: "polígono degenerado (2 pontos)", bubbles: [bubble([{ x: 30, y: 200 }, { x: 90, y: 240 }], "Deg")] },
  ];

  let failures = 0;
  for (const c of cases) {
    try {
      const out = await renderTranslatedPage(original, c.bubbles);
      const ok = out.qa.passed;
      console.log(`PASS  ${c.name} (qa=${JSON.stringify(out.qa.changedInsideMask)})`);
      if (!ok) { failures++; console.log(`      QA failed!`); }
    } catch (e: any) {
      failures++;
      console.log(`FAIL  ${c.name} -> ${e?.message}`);
    }
  }
  console.log(failures ? `\n${failures} caso(s) falharam` : "\nTodos os casos passaram");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
