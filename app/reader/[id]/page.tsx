import Link from "next/link";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import { createAdminClient } from "@/lib/supabase/admin";
import ReaderProgressTracker from "@/components/reader-progress-tracker";
import Immersive3D from "@/components/immersive-3d";
import ReaderClickScroll from "@/components/reader-click-scroll";

export const dynamic = "force-dynamic";

export default async function Reader({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ chapter?: string; view?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const access = await assertSeriesAccess(id);

  if (!access) {
    return <main className="auth"><div className="card"><h1>Obra não encontrada</h1><p>A obra não pertence à sessão atual.</p><Link className="button primary" href="/new">Começar uma tradução</Link></div></main>;
  }

  const admin = createAdminClient();
  const { data: chapters } = await admin.from("chapters")
    .select("id,chapter_number,title,status,progress_json").eq("series_id", id).order("chapter_number");

  const currentChapter = chapters?.find((chapter) => chapter.id === query.chapter) ?? chapters?.[0] ?? null;
  let pages: Array<{ id: string; page_number: number; translated_path: string | null; original_path: string; status: string }> = [];
  if (currentChapter) {
    const { data } = await admin.from("pages")
      .select("id,page_number,original_path,translated_path,status").eq("chapter_id", currentChapter.id).order("page_number");
    pages = (data ?? []) as typeof pages;
  }

  const view = query.view === "original" ? "original" : "translated";
  const translatedReady = pages.length > 0 && pages.every((page) => page.status === "ready" && Boolean(page.translated_path));
  const nextChapter = chapters?.find((chapter) => Number(chapter.chapter_number) > Number(currentChapter?.chapter_number ?? -Infinity));
  const previousChapter = [...(chapters ?? [])].reverse().find((chapter) => Number(chapter.chapter_number) < Number(currentChapter?.chapter_number ?? Infinity));

  return (
    <main className="reader-shell">
      <header className="reader-topbar">
        <Link className="brand" href="/"><b>T</b>Tradumanga</Link>
        <div className="reader-actions">
          <Link className="button ghost" href={`/upload/${id}`}>+ Importar capítulo</Link>
          <Link className="button ghost" href={view === "original" ? `/reader/${id}?chapter=${currentChapter?.id ?? ""}` : `/reader/${id}?chapter=${currentChapter?.id ?? ""}&view=original`}>
            {view === "original" ? "Ver tradução" : "Ver original"}
          </Link>
        </div>
      </header>

      {currentChapter && <ReaderProgressTracker seriesId={id} chapterId={currentChapter.id} />}

      <section className="reader-heading">
        <div>
          <small className="eyebrow">LEITOR</small>
          <h1>{access.series.title}</h1>
          <p>Tradução contextual em português. O original permanece disponível para comparação.</p>
        </div>
        <div className="reader-status">{translatedReady ? "TRADUÇÃO PRONTA" : currentChapter?.status === "ready" ? "PRONTO" : "PROCESSANDO"}</div>
      </section>

      <Immersive3D variant="reader" label={translatedReady ? "leitura · camada traduzida" : "leitura · preparando"} />

      <div className="reader-layout">
        <aside className="chapter-rail">
          <strong>Capítulos</strong>
          {(chapters ?? []).map((chapter) => (
            <Link key={chapter.id} className={chapter.id === currentChapter?.id ? "chapter-link active" : "chapter-link"} href={`/reader/${id}?chapter=${chapter.id}`}>
              <span>Cap. {chapter.chapter_number}</span>
              <small>{chapter.status === "ready" ? "Pronto" : "Processando"}</small>
            </Link>
          ))}
        </aside>

        <ReaderClickScroll>
          <div className="reader-chapter-nav">
            {previousChapter ? <Link className="button ghost" href={`/reader/${id}?chapter=${previousChapter.id}`}>← Anterior</Link> : <span />}
            <strong>{currentChapter ? `Capítulo ${currentChapter.chapter_number}` : "Capítulo"}</strong>
            {nextChapter ? <Link className="button ghost" href={`/reader/${id}?chapter=${nextChapter.id}`}>Próximo →</Link> : <span />}
          </div>

          {pages.length ? pages.map((page) => (
            <figure className="reader-page" key={page.id}>
              <img src={`/api/pages/${page.id}/image?variant=${view}`} alt={`Página ${page.page_number}`} />
              <figcaption>Página {page.page_number} · {view === "original" || !page.translated_path ? "original" : "traduzida"}</figcaption>
            </figure>
          )) : (
            <div className="empty reader-empty">
              <h2>{currentChapter?.status === "ready" ? "Nenhuma página disponível" : "Capítulo em processamento"}</h2>
              <p>O leitor será atualizado automaticamente quando o pipeline terminar.</p>
              <Link className="button primary" href={`/processing/${id}`}>Acompanhar processamento</Link>
            </div>
          )}
        </ReaderClickScroll>
      </div>
    </main>
  );
}
