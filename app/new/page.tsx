"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function New() {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();

  async function go(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErrorMessage("");

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      router.push("/login");
      return;
    }

    const slug = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const { data, error } = await supabase
      .from("manga_series")
      .insert({
        owner_id: user.id,
        title,
        slug,
      })
      .select("id")
      .single();

    if (error) {
      setErrorMessage(error.message);
      setCreating(false);
    } else {
      router.push("/reader/" + data.id);
    }
  }

  return (
    <main className="auth">
      <div className="card">
        <small>NOVA OBRA</small>
        <h1>Começar uma tradução</h1>
        <form onSubmit={go}>
          <label>
            Título
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <button className="button primary" disabled={creating}>
            {creating ? "Criando…" : "Criar obra"}
          </button>
        </form>
        {errorMessage && <p className="err">{errorMessage}</p>}
      </div>
    </main>
  );
}
