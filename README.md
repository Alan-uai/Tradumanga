# Tradumanga

Next.js + Supabase + Gemini + Inngest para tradução contextual de mangás/manhwas para pt-BR.

## Arquitetura

- Next.js/TypeScript na Vercel
- Inngest Cloud para orquestração durável
- Supabase PostgreSQL/Auth/Storage
- Gemini multimodal para OCR, contexto e tradução
- Sharp para ingestão, limpeza localizada, composição determinística e QA
- `@napi-rs/canvas` (Skia Canvas API) para renderização tipográfica em camadas PNG transparentes
- pdf-to-img para rasterização de PDF em Node
- bucket privado manga-pages

O antigo worker Docker foi removido. Não existe mais processo contínuo, polling, lease ou dependência de Python/OpenCV/Poppler/gallery-dl no caminho de produção.

## Pipeline

entrada → Inngest → ingestão → análise Gemini → Context Engine → tradução → limpeza localizada Sharp → texto Canvas → composição Sharp → QA de pixels → Storage → Reader

As páginas são processadas como funções independentes. O limite global do pipeline é de 5 etapas simultâneas, usando uma fila de concorrência compartilhada no Inngest.

1. tradumanga/chapter.process
2. tradumanga/page.analyze
3. tradumanga/page.translate
4. tradumanga/page.render

Cada etapa usa retries do Inngest e grava o estado operacional no Supabase.

## Inngest

O endpoint é /api/inngest.

Configure na Vercel:

```env
INNGEST_SIGNING_KEY=
INNGEST_EVENT_KEY=
```

A integração oficial da Vercel com Inngest pode provisionar a signing key automaticamente. Para desenvolvimento local, use INNGEST_DEV=1 e o Inngest Dev Server.

## Variáveis server-side

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
INNGEST_SIGNING_KEY=
INNGEST_EVENT_KEY=
```

SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY e as chaves do Inngest são exclusivamente server-side.

## Fontes

- Imagens: páginas existentes no Storage são normalizadas e processadas.
- PDF: rasterização feita por pdf-to-img, sem Poppler.
- URL: o sistema valida SSRF, identifica título/capítulo por metadata HTML/URL e extrai imagens diretamente da página.

A migração para Vercel/Inngest removeu a possibilidade de executar o binário gallery-dl. URLs que dependem de JavaScript ou de um extrator específico que não exponha as imagens no HTML precisam de um adaptador de fonte específico; isso é preferível a reintroduzir Docker no fluxo principal.

## Integridade

A imagem original nunca é sobrescrita.

O renderer usa o Canvas 2D do `@napi-rs/canvas` para rasterizar cada tradução em uma camada PNG transparente, com medição real de texto, quebra de linha, ajuste de fonte e orientação vertical/horizontal. Sharp limpa e compõe as camadas e gera a máscara somente a partir das regiões autorizadas pelo Gemini. O QA compara os pixels decodificados do original e do resultado, rejeita alterações fora da máscara e sinaliza texto que não cabe na região, exigindo:

diff(translated, original) ∩ outside_mask = 0

A página traduzida e a máscara são armazenadas como artefatos separados.

## Desenvolvimento

```bash
npm install
npm run dev
```

Para testar o fluxo localmente com o Inngest Dev Server:

```bash
INNGEST_DEV=1 npm run dev
```

Em outro terminal, execute o Dev Server do Inngest e aponte-o para http://localhost:3000/api/inngest.

## Supabase

O projeto usado pelo Tradumanga é voaavcicveaiitzbaogx. O projeto Otaku é independente e não faz parte desta arquitetura.
