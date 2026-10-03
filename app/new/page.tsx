"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { saveAnonymousWork } from "@/lib/anonymous/localState";
import Immersive3D from "@/components/immersive-3d";

type NewMode = "automatic" | "manual";

export default function New() {
  const [mode, setMode] = useState<NewMode>("automatic");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();

  async function submitAutomatic(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErrorMessage("");
    const response = await fetch("/api/import/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setErrorMessage(payload?.error ?? "Não foi possível iniciar a tradução pela URL.");
      setCreating(false);
      return;
    }
    await saveAnonymousWork({
      seriesId: payload.seriesId,
      isBookmarked: false,
      isFavorite: false,
      translationCompleted: false,
      lastChapterId: payload.chapterId ?? null,
      lastPageNumber: 1,
      updatedAt: new Date().toISOString(),
    });
    router.push("/processing/" + payload.seriesId);
  }

  async function submitManual(e: FormEvent) {
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
        <div className="import-header">
          <div>
            <small className="eyebrow">NOVA TRADUÇÃO</small>
            <h1>Traduzir por URL.</h1>
            <p>Cole a URL da página onde você está lendo. O Tradumanga identifica a obra e o capítulo, tenta o gallery-dl e, se necessário, extrai as imagens diretamente da página.</p>
          </div>
          <span className="anon-badge">Sem login</span>
        </div>

        <Immersive3D variant="input" label={mode === "automatic" ? "entrada · URL → visão" : "entrada · manual"} />

        <div className="source-tabs" role="tablist">
          <button type="button" className={mode === "automatic" ? "source-tab active" : "source-tab"} onClick={() => { setMode("automatic"); setErrorMessage(""); }}>
            <strong>Automático</strong><small>Somente URL</small>
          </button>
          <button type="button" className={mode === "manual" ? "source-tab active" : "source-tab"} onClick={() => { setMode("manual"); setErrorMessage(""); }}>
            <strong>Importação manual</strong><small>Imagens, PDF ou URL</small>
          </button>
        </div>

        {mode === "automatic" ? (
          <form onSubmit={submitAutomatic}>
            <label className="field">
              <span>URL onde você está lendo</span>
              <input required autoFocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://site.com/manga/obra/capitulo-123" />
              <small>Não informe nome da obra, número do capítulo ou páginas. O processamento identifica esses dados automaticamente.</small>
            </label>
            <div className="selection-summary"><span>Identificação automática</span><span>Gallery-dl + fallback HTML</span></div>
            <button className="button primary large" disabled={creating}>{creating ? "Identificando fonte…" : "Traduzir esta página"}</button>
          </form>
        ) : (
          <form onSubmit={submitManual}>
            <label className="field">
              <span>Nome da obra</span>
              <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: The Return of the Scorned Genius" />
            </label>
            <button className="button primary large" disabled={creating}>{creating ? "Criando…" : "Continuar para a fonte"}</button>
          </form>
        )}

        {errorMessage && <p className="err">{errorMessage}</p>}
      </section>
    </main>
  );
}
