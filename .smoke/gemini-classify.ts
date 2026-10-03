import { isRetryableGeminiError } from "@/lib/pipeline/gemini";

const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
  { name: "503 alta demanda (mensagem)", value: new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'), expected: true },
  { name: "status numérico 503", value: Object.assign(new Error("boom"), { status: 503 }), expected: true },
  { name: "status string UNAVAILABLE", value: Object.assign(new Error("boom"), { status: "UNAVAILABLE" }), expected: true },
  { name: "429 RESOURCE_EXHAUSTED", value: new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), expected: true },
  { name: "500 internal error", value: new Error('{"error":{"code":500,"status":"INTERNAL"}}'), expected: true },
  { name: "rede: fetch failed", value: new Error("fetch failed"), expected: true },
  { name: "rede: ECONNRESET", value: new Error("connect ECONNRESET"), expected: true },
  { name: "400 argumentos inválidos", value: new Error('{"error":{"code":400,"message":"Invalid JSON payload received.","status":"INVALID_ARGUMENT"}}'), expected: false },
  { name: "403 permissão", value: new Error('{"error":{"code":403,"status":"PERMISSION_DENIED"}}'), expected: false },
  { name: "404 modelo inexistente", value: new Error('{"error":{"code":404,"status":"NOT_FOUND"}}'), expected: false },
  { name: "chave de API inválida", value: new Error("API key not valid. Please pass a valid API key."), expected: false },
  { name: "SyntaxError de JSON", value: new SyntaxError("Unexpected token } in JSON"), expected: false },
];

let failures = 0;
for (const c of cases) {
  const got = isRetryableGeminiError(c.value);
  const ok = got === c.expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} -> ${got} (esperado ${c.expected})`);
}
console.log(failures ? `\n${failures} falha(s)` : "\nTodos os casos passaram");
process.exit(failures ? 1 : 0);
