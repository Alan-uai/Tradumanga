import sharp from "sharp";
import { renderTranslatedPage } from "@/lib/pipeline/inngest-runtime";

function bubble(polygon: Array<{ x: number; y: number }>, text: string, extra: Record<string, unknown> = {}) {
  return {
    polygon,
    bbox: null,
    source_text: "source",
    translated_text: text,
    style_json: { orientation: "horizontal", ...(extra as Record<string, unknown>) },
  };
}

async function main() {
  const original = await sharp({
    create: { width: 400, height: 600, channels: 3, background: { r: 240, g: 240, b: 235 } },
  }).jpeg().toBuffer();

  const cases: Array<{
    name: string;
    bubbles: Array<ReturnType<typeof bubble>>;
    expectedPass?: boolean;
  }> = [
    {
      name: "balão grande, texto curto",
      bubbles: [bubble([{ x: 50, y: 100 }, { x: 250, y: 100 }, { x: 250, y: 200 }, { x: 50, y: 200 }], "Tudo bem?")],
    },
    {
      name: "texto longo com quebra por largura real",
      bubbles: [bubble([{ x: 20, y: 300 }, { x: 180, y: 300 }, { x: 180, y: 420 }, { x: 20, y: 420 }], "Uma frase bem longa para forçar quebra de linha e testar o ajuste automático do texto dentro do balão.")],
    },
    {
      name: "acentos e pontuação em português",
      bubbles: [bubble([{ x: 30, y: 40 }, { x: 250, y: 40 }, { x: 250, y: 110 }, { x: 30, y: 110 }], "Você está bem? É incrível!", {
        font_family: "sans-serif",
        font_size: 28,
        font_weight: 700,
        letter_spacing: 0.4,
        text_color: "#171717",
      })],
    },
    {
      name: "fonte desconhecida com fallback",
      bubbles: [bubble([{ x: 50, y: 440 }, { x: 250, y: 440 }, { x: 250, y: 500 }, { x: 50, y: 500 }], "Fallback", { font_family: "fonte-inexistente-xyz" })],
    },
    {
      name: "texto vertical",
      bubbles: [bubble([{ x: 280, y: 80 }, { x: 350, y: 80 }, { x: 350, y: 300 }, { x: 280, y: 300 }], "翻訳テスト", { orientation: "vertical", font_size: 24 })],
    },
    {
      name: "bbox relativo (0..1)",
      bubbles: [{ ...bubble([], "Rel"), bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } }],
    },
    {
      name: "polígono fora dos limites",
      bubbles: [bubble([{ x: -50, y: -50 }, { x: 9999, y: -50 }, { x: 9999, y: 9999 }, { x: -50, y: 9999 }], "Fora")],
    },
    {
      name: "coordenadas relativas 0..1 no polígono",
      bubbles: [bubble([{ x: 0.05, y: 0.05 }, { x: 0.5, y: 0.05 }, { x: 0.5, y: 0.15 }, { x: 0.05, y: 0.15 }], "Relativo")],
    },
    {
      name: "sem balões traduzidos",
      bubbles: [],
    },
    {
      name: "texto em região pequena sinaliza overflow",
      bubbles: [bubble([{ x: 10, y: 10 }, { x: 13, y: 10 }, { x: 13, y: 13 }, { x: 10, y: 13 }], "Texto impossível de encaixar")],
      expectedPass: false,
    },
    {
      name: "balão estreito sinaliza overflow",
      bubbles: [bubble([{ x: 392, y: 500 }, { x: 400, y: 500 }, { x: 400, y: 540 }, { x: 392, y: 540 }], "Ok")],
      expectedPass: false,
    },
  ];

  let failures = 0;
  for (const testCase of cases) {
    try {
      const out = await renderTranslatedPage(original, testCase.bubbles);
      const expectedPass = testCase.expectedPass ?? true;
      const passed = out.qa.passed === expectedPass && out.qa.changedOutsideMask === 0;
      console.log(
        (passed ? "PASS " : "FAIL ") +
        testCase.name +
        " (outside=" + out.qa.changedOutsideMask +
        ", overflow=" + out.qa.textOverflow + ")",
      );
      if (!passed) failures++;
    } catch (error) {
      failures++;
      console.log("FAIL " + testCase.name + " -> " + (error instanceof Error ? error.message : String(error)));
    }
  }

  console.log(failures ? "\n" + failures + " caso(s) falharam" : "\nTodos os casos passaram");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
