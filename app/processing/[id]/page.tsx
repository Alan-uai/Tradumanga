import Link from "next/link";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import { createAdminClient } from "@/lib/supabase/admin";
import ProcessingClient from "@/components/processing-client";

export default async function ProcessingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assertSeriesAccess(id);

  if (!access) {
    return <main className="auth"><div className="card"><h1>Obra não encontrada</h1><p>A sessão atual não tem acesso a esta obra.</p><Link className="button primary" href="/new">Nova tradução</Link></div></main>;
  }

  const admin = createAdminClient();
  const { data: chapter, error } = await admin
    .from("chapters")
    .select("id")
    .eq("series_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !chapter) {
    return <main className="auth"><div className="card"><h1>Capítulo não encontrado</h1><p>Não foi possível localizar o capítulo em processamento.</p><Link className="button primary" href="/new">Nova tradução</Link></div></main>;
  }

  return <ProcessingClient seriesId={id} chapterId={chapter.id} title={access.series.title} />;
}
