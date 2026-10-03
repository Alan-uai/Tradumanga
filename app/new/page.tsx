"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function New() {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();

  async function go(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErrorMessage("");
    const response = await fetch("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setErrorMessage(payload?.error ?? "Não foi possível criar a obra.");
      setCreating(false);
      return;
    }
    router.push("/upload/" + payload.work.id);
  }

  return (
    <main className="import-screen">
      <section className="import-panel compact">
        <small className="eyebrow">NOVA OBRA</small>
        <h1>Traduzir um manga ou manhwa.</h1>
        <p>Não precisa preparar o capítulo. Depois de criar a obra, você escolhe imagem, PDF ou URL e o pipeline faz o restante.</p>
        <form onSubmit={go}>
          <label className="field">
            <span>Nome da obra</span>
            <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: The Return of the Scorned Genius" />
          </label>
          <button className="button primary large" disabled={creating}>{creating ? "Criando…" : "Continuar para a fonte"}</button>
        </form>
        {errorMessage && <p className="err">{errorMessage}</p>}
      </section>
    </main>
  );
}
