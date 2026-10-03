"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + "/dashboard" }
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">T</span><span>Tradumanga</span></div>
        <h1>Entrar</h1>
        <p>Receba um link de acesso seguro por e-mail.</p>
        <form onSubmit={submit}>
          <label>E-mail<input required type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@email.com" /></label>
          <button className="button primary" type="submit">Enviar link</button>
        </form>
        {sent && <div className="notice">Link enviado. Verifique seu e-mail.</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </main>
  );
}