"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type StatusPayload = {
  series?: { id: string; title: string };
  chapter?: { id: string; chapterNumber: number; title: string | null; status: string; errorMessage: string | null; progress: Record<string, number | string> };
  pages?: Record<string, number>;
  totalPages?: number;
  error?: string;
};

const stages = [
  ["download", "Download"],
  ["analysis", "Vision / OCR"],
  ["context", "Contexto"],
  ["translation", "Tradução"],
  ["render", "Renderização"],
  ["qa", "QA"],
] as const;

export default function ProcessingClient({ seriesId, title }: { seriesId: string; title: string }) {
  const router = useRouter();
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await fetch(`/api/chapters/${seriesId}/status`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? "Falha ao consultar o processamento.");
        if (stopped) return;
        setData(payload);
        if (payload.chapter?.status === "ready") {
          router.replace(`/reader/${seriesId}`);
          return;
        }
        if (payload.chapter?.status === "error") {
          setError(payload.chapter.errorMessage ?? "O processamento falhou.");
          return;
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Falha de comunicação.");
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [router, seriesId]);

  const chapter = data?.chapter;
  const progress = chapter?.progress ?? {};
  const pageCount = data?.totalPages ?? 0;
  const pageCounts = data?.pages ?? {};
  const overall = useMemo(() => {
    if (typeof progress.overall === "number") return progress.overall;
    return chapter?.status === "ready" ? 100 : 0;
  }, [chapter?.status, progress.overall]);

  return (
    <main className="processing-screen">
      <div className="processing-panel">
        <a className="back-link" href="/">← Biblioteca</a>
        <small className="eyebrow">TRADUÇÃO CONTEXTUAL</small>
        <h1>{data?.series?.title ?? title}</h1>
        <p className="processing-subtitle">
          {chapter ? `Capítulo ${chapter.chapterNumber > 0 ? chapter.chapterNumber : "identificando"} — processamento em andamento` : "Preparando capítulo…"}
        </p>

        <section className="progress-card">
          {stages.map(([key, label]) => {
            const value = typeof progress[key] === "number" ? Number(progress[key]) : 0;
            return <div className="progress-row" key={key}>
              <span>{label}</span>
              <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
              <b>{Math.round(value)}%</b>
            </div>;
          })}
          <div className="overall"><span>Processamento total</span><b>{Math.round(overall)}%</b></div>
        </section>

        <section className="context-grid">
          <article className="context-card">
            <h2>Estado real do pipeline</h2>
            <p>{pageCount ? `${pageCount} página(s) no capítulo.` : "Aguardando a ingestão das páginas."}</p>
            <dl>
              <div><dt>Download</dt><dd>{pageCount ? "Concluído" : "Preparando"}</dd></div>
              <div><dt>Vision / OCR</dt><dd>{pageCounts.analyzed ?? 0} analisadas</dd></div>
              <div><dt>Tradução</dt><dd>{pageCounts.translated ?? 0} traduzidas</dd></div>
              <div><dt>Renderização</dt><dd>{pageCounts.ready ?? 0} prontas</dd></div>
            </dl>
          </article>
          <article className="context-card">
            <h2>Context Engine</h2>
            <p>{progress.contextReady === 100 ? "Contexto do capítulo consolidado. A tradução usa continuidade, personagens e glossário." : "O contexto narrativo será consolidado somente após todas as páginas terem sido analisadas."}</p>
            <span className={progress.contextReady === 100 ? "status-pill ready" : "status-pill"}>{progress.contextReady === 100 ? "CONTEXTO PRONTO" : "CONSTRUINDO CONTEXTO"}</span>
          </article>
        </section>

        {error && <div className="error-box">{error}</div>}
      </div>
    </main>
  );
}
