import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Reader({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: work } = await supabase.from("manga_series").select("id,title,status").eq("id", id).single();
  const { data: chapters } = await supabase.from("chapters").select("id,chapter_number,title,status").eq("series_id", id).order("chapter_number");

  return <main className="reader-shell">
    <header className="topbar"><Link className="brand" href="/dashboard"><span className="brand-mark">T</span><span>Tradumanga</span></Link><span className="status">{work?.status ?? "obra"}</span></header>
    <section className="reader-head"><div><div className="eyebrow">LEITOR</div><h1>{work?.title ?? "Obra"}</h1><p>Camada traduzida separada da imagem original.</p></div><Link className="button primary" href="/dashboard">Biblioteca</Link></section>
    <div className="reader-layout">
      <aside className="chapter-list"><h3>Capítulos</h3>{chapters?.length ? chapters.map(c => <div className="chapter-row" key={c.id}>Cap. {c.chapter_number}{c.title ? " — "+c.title : ""}<span>{c.status}</span></div>) : <p className="muted">Nenhum capítulo importado.</p>}</aside>
      <section className="reader-stage"><div className="manga-placeholder"><div className="bubble bubble-a">A tradução contextual<br/>aparece aqui.</div><div className="bubble bubble-b">A arte original permanece preservada.</div><span className="page-note">PÁGINA DE PRÉVIA</span></div></section>
    </div>
  </main>;
}