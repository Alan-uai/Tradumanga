"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function New() {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();

  async function go(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErrorMessage("");

    const response = await fetch("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setErrorMessage(payload?.error ?? "Não foi possível criar a obra.");
      setCreating(false);
      return;
    }

    router.push("/upload/" + payload.work.id);
  }

  return (
    <main className="auth">
      <div className="card">
        <small>NOVA OBRA</small>
        <h1>Começar uma tradução</h1>
        <p>A tradução pode ser iniciada sem criar uma conta.</p>
        <form onSubmit={go}>
          <label>
            Título
            <input required value={title} onChange={(e) => setTitle(e.target.value)} />
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
