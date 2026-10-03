"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { saveAnonymousWork } from "@/lib/anonymous/localState";

type Mode = "images" | "pdf" | "url";

export default function Upload() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [chapter, setChapter] = useState("1");
  const [mode, setMode] = useState<Mode>("images");
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const selectedLabel = useMemo(() => {
    if (mode === "images") return files.length ? `${files.length} página(s) selecionada(s)` : "Escolha as imagens na ordem do capítulo.";
    if (mode === "pdf") return files[0]?.name ?? "Escolha um arquivo PDF.";
    return url ? "URL pronta para processamento." : "Cole a URL do capítulo ou volume.";
  }, [files, mode, url]);

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  async function submit() {
    if (mode === "images" && !files.length) return setMsg("Selecione pelo menos uma imagem.");
    if (mode === "pdf" && (!files.length || files[0].type !== "application/pdf")) return setMsg("Selecione um PDF.");
    if (mode === "url" && !url.trim()) return setMsg("Informe a URL.");
    setBusy(true);
    setMsg("");

    const chapterResponse = await fetch("/api/chapters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesId: id, chapterNumber: Number(chapter), sourceType: mode, sourceUrl: mode === "url" ? url.trim() : null }),
    });
    const chapterPayload = await chapterResponse.json().catch(() => null);
    if (!chapterResponse.ok) {
      setMsg(chapterPayload?.error ?? "Não foi possível criar o capítulo.");
      setBusy(false);
      return;
    }

    const chapterId = chapterPayload.chapter.id;
    const supabase = createClient();

    try {
      if (mode === "images") {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const prepare = await fetch(`/api/chapters/${chapterId}/pages/upload-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pageNumber: i + 1, filename: file.name, contentType: file.type }),
          });
          const payload = await prepare.json().catch(() => null);
          if (!prepare.ok) throw new Error(payload?.error ?? "Falha ao preparar uma página.");
          const { error } = await supabase.storage.from("manga-pages").uploadToSignedUrl(
            payload.path, payload.token, file, { contentType: file.type },
          );
          if (error) throw error;
        }
      }

      if (mode === "pdf") {
        const file = files[0];
        const prepare = await fetch(`/api/chapters/${chapterId}/source-upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type }),
        });
        const payload = await prepare.json().catch(() => null);
        if (!prepare.ok) throw new Error(payload?.error ?? "Falha ao preparar o PDF.");
        const { error } = await supabase.storage.from("manga-pages").uploadToSignedUrl(
          payload.path, payload.token, file, { contentType: file.type },
        );
        if (error) throw error;
      }

      await saveAnonymousWork({
        seriesId: id,
        isBookmarked: false,
        isFavorite: false,
        translationCompleted: false,
        lastChapterId: chapterId,
        lastPageNumber: 1,
        updatedAt: new Date().toISOString(),
      });

      const enqueue = await fetch(`/api/chapters/${chapterId}/enqueue`, { method: "POST" });
      const enqueuePayload = await enqueue.json().catch(() => null);
      if (!enqueue.ok) throw new Error(enqueuePayload?.error ?? "Não foi possível iniciar o processamento.");

      router.push(`/processing/${id}`);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Falha ao importar a fonte.");
      setBusy(false);
    }
  }

  return (
    <main className="import-screen">
      <section className="import-panel">
        <div className="import-header">
          <div>
            <small className="eyebrow">NOVA TRADUÇÃO</small>
            <h1>Escolha a fonte.</h1>
            <p>Você fornece imagem, PDF ou URL. O Tradumanga baixa, analisa o capítulo inteiro, entende o contexto e só então traduz.</p>
          </div>
          <span className="anon-badge">Sem login</span>
        </div>

        <label className="field">
          <span>Capítulo</span>
          <input type="number" min="0" step="0.1" value={chapter} onChange={(e) => setChapter(e.target.value)} />
        </label>

        <div className="source-tabs" role="tablist">
          {([
            ["images", "Imagens", "JPG, PNG, WEBP"],
            ["pdf", "PDF", "Volume ou capítulo"],
            ["url", "URL", "Fonte online"],
          ] as const).map(([value, label, hint]) => (
            <button type="button" key={value} className={mode === value ? "source-tab active" : "source-tab"} onClick={() => { setMode(value); setMsg(""); }}>
              <strong>{label}</strong><small>{hint}</small>
            </button>
          ))}
        </div>

        {mode === "images" && (
          <label className="dropzone">
            <input type="file" accept="image/*" multiple onChange={onFiles} />
            <strong>Adicionar páginas</strong>
            <span>Selecione várias imagens. A ordem dos arquivos define a ordem do capítulo.</span>
          </label>
        )}

        {mode === "pdf" && (
          <label className="dropzone">
            <input type="file" accept="application/pdf,.pdf" onChange={onFiles} />
            <strong>Adicionar PDF</strong>
            <span>O worker converte cada página em uma imagem original para análise e tradução.</span>
          </label>
        )}

        {mode === "url" && (
          <label className="field">
            <span>URL do capítulo / volume</span>
            <input type="url" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
            <small>O worker valida a URL, baixa a fonte e usa gallery-dl quando o site exigir um extrator de galeria.</small>
          </label>
        )}

        <div className="selection-summary"><span>{selectedLabel}</span><span>Original preservado</span></div>
        <button className="button primary large" disabled={busy} onClick={submit}>{busy ? "Preparando pipeline…" : "Começar tradução"}</button>
        {msg && <p className="err">{msg}</p>}
      </section>
    </main>
  );
}
