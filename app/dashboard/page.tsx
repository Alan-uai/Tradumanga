import Link from "next/link";
import {createClient} from "@/lib/supabase/server";
import Immersive3D from "@/components/immersive-3d";

export default async function Dashboard(){
  const s=await createClient();
  const{data:{user}}=await s.auth.getUser();
  const{data:works}=user?await s.from("manga_series").select("id,title,status,logo_path,banner_path,cover_path").order("created_at",{ascending:false}):{data:[]};
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/"><b>T</b>Tradumanga</Link><span>{user?.email??""}</span></header>
    <section className="head">
      <div><small className="eyebrow">BIBLIOTECA</small><h1>Suas obras</h1><p>Gerencie obras e acompanhe a tradução contextual.</p></div>
      <Link className="button primary" href="/new">+ Nova obra</Link>
    </section>
    <Immersive3D variant="reader" label="biblioteca · estado sincronizado" />
    {works?.length?<div className="grid">{works.map(w=><Link className="work" href={"/reader/"+w.id} key={w.id}>
      <div className="work-art">
        <img className="work-banner" src={"/api/series/"+w.id+"/asset?type=banner"} alt="" />
        <div className="work-art-shade" />
        <div className="work-logo-wrap">
          <img className="work-logo" src={"/api/series/"+w.id+"/asset?type=logo"} alt={w.title} />
        </div>
      </div>
      <strong>{w.title}</strong>
      <small>{w.status}</small>
    </Link>)}</div>:<div className="empty"><h2>Nenhuma obra ainda</h2><p>Crie sua primeira obra para começar.</p><Link className="button primary" href="/new">Criar obra</Link></div>}
  </main>
}