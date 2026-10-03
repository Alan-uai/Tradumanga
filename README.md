# Tradumanga

Next.js + Supabase + Gemini para tradução contextual de mangás/manhwas para pt-BR.

## Infraestrutura

- GitHub: `Alan-uai/Tradumanga`
- Supabase: projeto independente `Tradumanga`, região sa-east-1
- PostgreSQL + pgvector
- Supabase Auth + Storage
- Bucket privado `manga-pages`
- RLS por proprietário
- Tabelas de obras, capítulos, páginas, análises multimodais, balões, jobs e glossário
- Worker Docker separado para o pipeline pesado

## Variáveis da aplicação web

Configure na Vercel:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
```

`SUPABASE_SERVICE_ROLE_KEY` e `GEMINI_API_KEY` são exclusivamente server-side. Não devem ser expostas ao cliente.

## Variáveis do worker

O worker Docker precisa de:

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
WORKER_ID=tradumanga-worker
JOB_LEASE_SECONDS=1800
JOB_HEARTBEAT_MS=60000
WORKER_POLL_INTERVAL_MS=2000
WORKER_TMP_DIR=/tmp/tradumanga
GALLERY_DL_METADATA_TIMEOUT_MS=90000
GALLERY_DL_TIMEOUT_MS=300000
```

O worker deve rodar como processo contínuo em infraestrutura Docker. A Vercel hospeda a aplicação web/API; ela não executa esse worker persistente.

## Deploy do worker

O repositório contém `worker/Dockerfile` e `render.yaml`. O serviço Docker deve ser configurado com as três credenciais secretas do worker e iniciado a partir da branch `main`.

O worker consome `translation_jobs` do Supabase, renova o lease durante jobs longos e executa:

1. ingestão da fonte;
2. OCR/análise multimodal;
3. Context Engine;
4. tradução contextual;
5. renderização determinística;
6. QA de integridade de pixels;
7. armazenamento e conclusão do capítulo.

## Desenvolvimento

```bash
npm install
npm run dev
```

Para executar o worker localmente:

```bash
npm run worker
```
