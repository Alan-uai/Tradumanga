"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function NewWork() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError("");
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/login"); return; }
    const slug = title.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const { data, error } = await supabase.from("manga_series").insert({ owner_id: user.id, title, slug }).select("id").single();
    if (error) { setError(error.message); setSaving(false); return; }
    router.push("/reader/" + data.id);
  }

  return <main className="auth-shell"><div className="auth-card wide"><div className="eyebrow">NOVA OBRA</div><h1>Começar uma tradução</h1><p>Dê um nome à obra. Os capítulos e páginas serão adicionados em seguida.</p><form onSubmit={submit}><label>Título da obra<input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex.: The Return of the Scorned Genius" /></label><button className="button primary" disabled={saving}>{saving ? "Criando..." : "Criar obra"}</button></form>{error && <div className="error">{error}</div>}</div></main>;
}