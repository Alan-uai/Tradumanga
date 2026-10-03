import Link from "next/link";

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">T</span><span>Tradumanga</span></div>
        <Link className="button ghost" href="/login">Entrar</Link>
      </header>

      <section className="hero">
        <div className="eyebrow">TRADUÇÃO CONTEXTUAL</div>
        <h1>Seu mangá em português.<br /><em>Sem perder a cena.</em></h1>
        <p className="hero-copy">
          O Tradumanga entende a página, a história e o contexto dos diálogos antes de traduzir.
          A arte original permanece intacta; somente as falas são localizadas.
        </p>
        <div className="hero-actions">
          <Link className="button primary" href="/dashboard">Começar tradução</Link>
          <Link className="button ghost" href="#como-funciona">Como funciona</Link>
        </div>
      </section>

      <section id="como-funciona" className="feature-grid">
        <article><span>01</span><h2>Compreensão</h2><p>Analisa imagem, personagens, sequência narrativa e contexto antes de escolher a expressão.</p></article>
        <article><span>02</span><h2>Localização</h2><p>Traduz para pt-BR com coerência de tom, intenção, honoríficos e glossário da obra.</p></article>
        <article><span>03</span><h2>Preservação</h2><p>Mantém a página original como fonte e gera uma camada traduzida separada para leitura.</p></article>
      </section>
    </main>
  );
}