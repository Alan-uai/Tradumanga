# Tradumanga Worker

Worker Docker independente para consumir `translation_jobs` do Supabase e executar o pipeline pesado de ingestão, OCR/contexto, tradução, renderização e QA.

## Runtime

O worker deve rodar como um serviço Docker contínuo. Ele não deve ser executado dentro de uma rota da Vercel.

O worker:

1. reivindica jobs com `claim_translation_job`;
2. renova o lease enquanto processa;
3. executa `process_chapter`, `analyze_page`, `translate_page` e `render_page`;
4. conclui ou reencaminha o job para retry;
5. encerra de forma controlada em SIGTERM/SIGINT.

## Variáveis obrigatórias

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
```

## Variáveis recomendadas

```env
WORKER_ID=tradumanga-worker
JOB_LEASE_SECONDS=1800
JOB_HEARTBEAT_MS=60000
WORKER_POLL_INTERVAL_MS=2000
WORKER_TMP_DIR=/tmp/tradumanga
GALLERY_DL_METADATA_TIMEOUT_MS=90000
GALLERY_DL_TIMEOUT_MS=300000
```

## Deploy

O repositório inclui `render.yaml` para um serviço Worker Docker. Configure as três variáveis secretas no provedor do container e faça o deploy a partir da branch `main`.

O mesmo container pode ser executado em qualquer provedor que suporte Docker com processo contínuo.
