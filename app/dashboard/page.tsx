import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: series } = user
    ? await supabase.from("manga_series").select("id,title,status,created_at").order("created_at", { ascending: false })
    : { data: [] as any[] };

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">T</span><span>Tradumanga</span></Link>
        <div className="top-actions">{user ? <span className="user-chip">{user.email}</span> : <Link className="button ghost" href="/login">Entrar</Link>}</div>
      </header>

      <section className="dashboard-head">
        <div><div className="eyebrow">BIBLIOTECA</div><h1>Suas obras</h1><p>Importe capítulos e acompanhe o processamento contextual.</p></div>
        <Link className="button primary" href="/new">+ Nova obra</Link>
      </section>

      {series && series.length > 0 ? (
        <div className="library-grid">{series.map((item: any) => (
          <Link href={"/reader/" + item.id} className="work-card" key={item.id}>
            <div className="work-cover"><span>T</span></div>
            <div><h2>{item.title}</h2><span className="status">{item.status}</span></div>
          </Link>
        ))}</div>
      ) : (
        <div className="empty-state"><div className="empty-icon">＋</div><h2>Nenhuma obra ainda</h2><p>Crie sua primeira obra para iniciar a tradução contextual.</p><Link className="button primary" href="/new">Criar obra</Link></div>
      )}
    </main>
  );
}