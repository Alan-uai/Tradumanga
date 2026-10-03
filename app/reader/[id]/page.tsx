import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import ReaderProgressTracker from "@/components/reader-progress-tracker";

export default async function Reader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assertSeriesAccess(id);

  if (!access) {
    return <main className="auth"><div className="card"><h1>Obra não encontrada</h1><p>A obra não pertence à sessão atual.</p><Link className="button primary" href="/new">Começar uma tradução</Link></div></main>;
  }

  const admin = createAdminClient();
  const { data: chapters } = await admin.from("chapters")
    .select("id,chapter_number,title,status").eq("series_id",id).order("chapter_number");

  const firstChapter = chapters?.[0] ?? null;
  let pages: Array<{ id:string; page_number:number; original_path:string; translated_path:string|null; status:string }> = [];

  if (firstChapter) {
    const result = await admin.from("pages")
      .select("id,page_number,original_path,translated_path,status")
      .eq("chapter_id",firstChapter.id).order("page_number");
    pages = (result.data ?? []) as typeof pages;
  }

  const imageUrls = await Promise.all(
    pages.map(async (page) => {
      const path = page.translated_path ?? page.original_path;
      const { data } = await admin.storage.from("manga-pages").createSignedUrl(path, 60 * 10);
      return { ...page, url: data?.signedUrl ?? null };
    }),
  );

  return (
    <main className="shell">
      <ReaderProgressTracker seriesId={id} chapterId={firstChapter?.id ?? null} />
      <header className="topbar">
        <Link className="brand" href="/"><b>T</b>Tradumanga</Link>
        <div><Link className="button ghost" href={"/upload/"+id}>+ Importar capítulo</Link><small>{access.series.status}</small></div>
      </header>
      <section className="head">
        <div><small>LEITOR</small><h1>{access.series.title}</h1><p>Original preservado + camada traduzida contextual.</p></div>
      </section>
      <div className="reader-grid">
        <aside className="chapters">
          <strong>Capítulos</strong>
          {chapters?.map(c=><div key={c.id}>Cap. {c.chapter_number}<small>{c.status}</small></div>)}
        </aside>
        <div className="reader">
          {imageUrls.length ? imageUrls.map(page => page.url ? <img key={page.id} src={page.url} alt={`Página ${page.page_number}`} /> : null) :
            <div className="page"><div className="bubble">Aguardando páginas e processamento.</div></div>}
        </div>
      </div>
    </main>
  );
}
