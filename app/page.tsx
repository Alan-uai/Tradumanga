import Link from "next/link";
import Immersive3D from "@/components/immersive-3d";

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><b>T</b>Tradumanga</div>
        <Link className="button ghost" href="/login">Entrar</Link>
      </header>

      <section className="hero hero--immersive">
        <div className="hero-copy">
          <small className="eyebrow">TRADUÇÃO CONTEXTUAL · VISION + IA</small>
          <h1>Seu mangá em português.<br/><i>Sem perder a cena.</i></h1>
          <p>O Tradumanga entende a página, a história e o contexto antes de traduzir. A arte original permanece como fonte; a camada traduzida é gerada separadamente.</p>
          <div className="hero-actions">
            <Link className="button primary" href="/new">Começar tradução</Link>
            <a className="button ghost" href="#features">Como funciona</a>
          </div>
        </div>
        <Immersive3D variant="hero" label="context engine · ativo" />
      </section>

      <section id="features" className="features features--interactive">
        <article><small>01</small><h2>Compreensão</h2><p>Imagem, sequência narrativa, personagens e intenção antes da tradução.</p></article>
        <article><small>02</small><h2>Localização</h2><p>Português brasileiro natural, coerente com tom, contexto e glossário da obra.</p></article>
        <article><small>03</small><h2>Preservação</h2><p>Original e resultado permanecem separados para evitar alteração irreversível da fonte.</p></article>
      </section>
    </main>
  );
}