const key = "test-key";
process.env.GEMINI_API_KEY = key;

const originalFetch = globalThis.fetch;
let calls = 0;
let mode: "503" | "400" | "flaky" = "503";

globalThis.fetch = (async () => {
  calls++;
  if (mode === "flaky") {
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"story_context":"ok","bubbles":[]}' }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (mode === "503") {
    return new Response(
      JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  const { analyzePageWithGemini } = await import("@/lib/pipeline/gemini");

  mode = "503";
  calls = 0;
  const started = Date.now();
  let error503 = "";
  try {
    await analyzePageWithGemini({ imageBase64: "AAAA", mimeType: "image/png" });
  } catch (e) { error503 = e instanceof Error ? e.message : String(e); }
  const elapsed503 = Date.now() - started;
  const ok503 = calls === 14 && /indisponível/.test(error503) && elapsed503 >= 3000;
  console.log(`${ok503 ? "PASS" : "FAIL"}  503 persistente -> chamadas=${calls} (esperado 14), elapsed=${elapsed503}ms (esperado >=3000 por backoff), msg="${error503.slice(0, 80)}..."`);

  mode = "400";
  calls = 0;
  const started400 = Date.now();
  let error400 = "";
  try {
    await analyzePageWithGemini({ imageBase64: "AAAA", mimeType: "image/png" });
  } catch (e) { error400 = e instanceof Error ? e.message : String(e); }
  const elapsed400 = Date.now() - started400;
  const ok400 = calls === 7 && elapsed400 < 2000 && /indisponível/.test(error400);
  console.log(`${ok400 ? "PASS" : "FAIL"}  400 fatal -> chamadas=${calls} (esperado 7, sem backoff), elapsed=${elapsed400}ms`);

  mode = "flaky";
  calls = 0;
  let flakyResult: unknown = null;
  try {
    flakyResult = await analyzePageWithGemini({ imageBase64: "AAAA", mimeType: "image/png" });
  } catch (e) { flakyResult = { thrown: e instanceof Error ? e.message : String(e) }; }
  const okFlaky = calls === 2 && (flakyResult as any)?.story_context === "ok";
  console.log(`${okFlaky ? "PASS" : "FAIL"}  503 pontual -> chamadas=${calls} (esperado 2: retry no mesmo modelo), resultado=${JSON.stringify(flakyResult)}`);

  globalThis.fetch = originalFetch;
  process.exit(ok503 && ok400 && okFlaky ? 0 : 1);
}

main().catch((e) => { console.error(e); globalThis.fetch = originalFetch; process.exit(2); });
