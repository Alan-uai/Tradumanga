# Tradumanga

Next.js + Supabase + Gemini para tradução contextual de mangás/manhwas para pt-BR.

## Infraestrutura criada

- GitHub: Alan-uai/Tradumanga
- Supabase: projeto independente `Tradumanga`, região sa-east-1
- PostgreSQL + pgvector
- Supabase Auth + Storage
- Bucket privado `manga-pages`
- RLS por proprietário
- Tabelas de obras, capítulos, páginas, análises multimodais, balões, jobs e glossário

## Variáveis

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
GEMINI_API_KEY=
```

O projeto não deve armazenar chaves privadas do Supabase no cliente.

## Pipeline planejado

1. Upload da página original.
2. Análise multimodal/contextual com Gemini.
3. Extração dos balões e texto.
4. Tradução contextual para pt-BR usando histórico da obra e glossário.
5. Renderização da camada traduzida sem sobrescrever o arquivo original.
6. Leitura e revisão.

## Desenvolvimento

```bash
npm install
npm run dev
```
