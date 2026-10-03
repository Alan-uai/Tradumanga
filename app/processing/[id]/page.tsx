import Link from "next/link";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import ProcessingClient from "@/components/processing-client";

export default async function ProcessingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assertSeriesAccess(id);

  if (!access) {
    return <main className="auth"><div className="card"><h1>Obra não encontrada</h1><p>A sessão atual não tem acesso a esta obra.</p><Link className="button primary" href="/new">Nova tradução</Link></div></main>;
  }

  return <ProcessingClient seriesId={id} title={access.series.title} />;
}
