import sharp from "sharp";
import { readFile } from "node:fs/promises";

export async function verifyPixelIntegrity(originalPath: string, translatedPath: string, maskPath: string) {
  const [original, translated, mask] = await Promise.all([
    sharp(originalPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(translatedPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskPath).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (original.info.width !== translated.info.width || original.info.height !== translated.info.height) {
    throw new Error("QA: dimensões da imagem traduzida diferem do original.");
  }
  if (mask.info.width !== original.info.width || mask.info.height !== original.info.height) {
    throw new Error("QA: máscara possui dimensões incompatíveis.");
  }

  const a = original.data;
  const b = translated.data;
  const m = mask.data;
  let changedOutsideMask = 0;
  let changedInsideMask = 0;

  for (let i = 0, p = 0; i < a.length; i += original.info.channels, p++) {
    const allowed = m[p] > 0;
    const same = a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2];
    if (!same && allowed) changedInsideMask++;
    if (!same && !allowed) changedOutsideMask++;
  }

  if (changedOutsideMask !== 0) {
    throw new Error(`QA: ${changedOutsideMask} pixels foram alterados fora da máscara autorizada.`);
  }

  return {
    passed: true,
    changedInsideMask,
    changedOutsideMask,
    width: original.info.width,
    height: original.info.height,
  };
}
