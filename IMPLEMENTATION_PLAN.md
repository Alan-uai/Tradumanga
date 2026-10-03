# Tradumanga — Plano de Implementação

> Documento mestre do projeto. A implementação deve seguir as fases abaixo em ordem, mantendo o arquivo original da página imutável e produzindo artefatos derivados/versionados.

## 1. Objetivo

Construir uma aplicação web para importar, analisar, traduzir e ler mangás/manhwas em português do Brasil.

Princípio central:

- a imagem original nunca é sobrescrita;
- Gemini é usado para visão multimodal, OCR, compreensão narrativa, contexto visual e tradução contextual;
- a tradução não deve ser literal quando outra formulação em pt-BR representar melhor intenção, tom, relação entre personagens e situação;
- somente regiões destinadas a texto podem ser alteradas na imagem traduzida;
- a arte, personagens, cenários, efeitos visuais e demais pixels fora das regiões de texto devem permanecer preservados;
- todo resultado relevante deve ser versionável e revisável.

## 2. Stack

- Next.js + TypeScript
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- pgvector
- Gemini multimodal
- Vercel para aplicação web
- worker externo para tarefas pesadas/assíncronas
- renderer determinístico para composição da página traduzida

## 3. Arquitetura

Fluxo principal:

1. usuário cria/importa uma obra;
2. capítulo é criado;
3. páginas originais são enviadas ao Storage privado;
4. cada página recebe hash e metadados;
5. jobs são criados para processamento;
6. Gemini analisa cada página;
7. o sistema identifica balões, caixas, texto, onomatopeias e regiões relevantes;
8. o Context Engine consolida contexto da página, capítulo e obra;
9. Gemini traduz para pt-BR usando contexto e glossário;
10. o renderer cria máscaras somente nas regiões autorizadas;
11. o texto traduzido é composto preservando estilo, posição e leitura natural;
12. QA verifica a saída;
13. a página traduzida é salva como artefato separado;
14. o leitor exibe a versão traduzida e permite revisão.

## 4. Banco de dados

Entidades principais:

- manga_series
- chapters
- pages
- page_analyses
- speech_bubbles
- translation_jobs
- glossary_terms

Requisitos:

- RLS por proprietário;
- Storage privado;
- original_path imutável;
- translated_path separado;
- status explícito para obra, capítulo, página e job;
- análises e traduções versionáveis;
- pgvector disponível para recuperação semântica futura.

## 5. Invariantes de integridade da imagem

A implementação deve tratar a imagem original como fonte imutável.

Para uma página original O e uma página traduzida T:

- o arquivo O nunca é alterado;
- regiões fora da máscara autorizada devem permanecer iguais;
- a diferença entre O e T fora das regiões autorizadas deve ser zero;
- conceito operacional: diff(T, O) ∩ outside_mask = 0.

A máscara deve ser derivada da análise dos balões/regiões de texto, nunca de uma reconstrução livre da imagem inteira.

## 6. Pipeline de processamento

### Fase A — Fundação

- [x] Repositório GitHub
- [x] Projeto Supabase independente Tradumanga
- [x] Auth/RLS
- [x] Storage privado
- [x] Schema inicial
- [x] Aplicação Next.js
- [x] Login
- [x] Dashboard
- [x] Criação de obra
- [x] Upload de capítulo/páginas
- [x] Endpoint inicial Gemini
- [x] Deploy Vercel funcional

### Fase B — Orquestração

- [ ] fila de jobs transacionais
- [ ] claim atômico com SKIP LOCKED
- [ ] retry/recovery de jobs
- [ ] processamento por página
- [ ] processamento por capítulo
- [ ] idempotência
- [ ] observabilidade de status e erros

### Fase C — Ingestão e cache

- [ ] canonicalização de URLs
- [ ] identificação de site/fonte
- [ ] download de originais
- [ ] SHA-256
- [ ] deduplicação por URL/hash
- [ ] reutilização de capítulos e imagens já importados
- [ ] versionamento dos artefatos

Para fontes externas, o downloader/worker deve ficar separado do runtime web.

### Fase D — Visão e OCR contextual

- [ ] análise multimodal da página
- [ ] identificação de balões e caixas
- [ ] bounding boxes/polígonos
- [ ] OCR
- [ ] idioma de origem
- [ ] direção de leitura
- [ ] onomatopeias
- [ ] texto vertical/horizontal
- [ ] estilo aproximado
- [ ] confiança
- [ ] contexto visual
- [ ] contexto narrativo

### Fase E — Context Engine

O sistema deve compreender a história antes de decidir a tradução.

Contexto utilizado, em ordem:

1. texto e elementos da página atual;
2. páginas próximas;
3. contexto acumulado do capítulo;
4. contexto da obra;
5. glossário da obra;
6. traduções previamente aprovadas.

O contexto não deve autorizar invenção de texto que não esteja presente.

### Fase F — Tradução contextual

- [ ] tradução para pt-BR
- [ ] preservação de intenção
- [ ] adequação de registro
- [ ] naturalidade de diálogo
- [ ] consistência de nomes/termos
- [ ] glossário
- [ ] notas de tradução
- [ ] confidence
- [ ] versionamento
- [ ] revisão humana

### Fase G — Renderer

Pipeline:

1. carregar original;
2. carregar regiões autorizadas;
3. gerar máscara;
4. remover somente o texto da região;
5. preservar textura/fundo sempre que possível;
6. compor texto pt-BR;
7. respeitar direção, alinhamento, quebra de linha e estilo;
8. gerar imagem traduzida;
9. salvar como novo artefato.

O renderer deve ser determinístico. Gemini não deve ser usado para reconstruir a página inteira.

### Fase H — QA visual e integridade

Validações:

- imagem traduzida existe;
- dimensões corretas;
- formato correto;
- nenhuma alteração fora das máscaras;
- todos os balões esperados foram renderizados;
- nenhum texto ficou cortado;
- overflow;
- legibilidade;
- contraste;
- ordem de leitura;
- integridade do Storage;
- consistência de versão.

### Fase I — Leitor

- [ ] seleção de capítulo
- [ ] navegação página a página
- [ ] modo original/traduzido
- [ ] indicador de processamento
- [ ] revisão de tradução
- [ ] edição de balões
- [ ] regeneração de uma página
- [ ] progresso do capítulo

### Fase J — Observabilidade e escala

- [ ] logs estruturados
- [ ] métricas de jobs
- [ ] retries com backoff
- [ ] limites de concorrência Gemini
- [ ] proteção contra duplicação
- [ ] cleanup de artefatos temporários
- [ ] novos sites/fontes
- [ ] processamento paralelo por capítulo/página quando seguro

## 7. Versionamento

Cada etapa importante deve poder ser rastreada.

Exemplos:

- modelo Gemini utilizado;
- versão do prompt;
- versão da análise;
- versão da tradução;
- versão do renderer;
- hash do original;
- hash do artefato traduzido.

## 8. Regras de implementação

1. Não sobrescrever originais.
2. Não colocar chaves privadas no cliente.
3. Não executar tarefas longas diretamente no request HTTP quando puderem ser jobs.
4. Toda operação deve ser idempotente sempre que possível.
5. Falhas parciais não podem corromper o capítulo.
6. O sistema deve permitir retomar processamento.
7. Uma falha em uma página não deve apagar resultados válidos das demais.
8. O leitor deve distinguir claramente processamento, pronto e erro.
9. Alterações de banco devem ser feitas por migrations.
10. Mudanças de código devem ser pequenas e verificáveis.
11. Antes de adicionar novos componentes, validar o build e o fluxo existente.
12. O projeto Supabase chamado Otaku é independente e não deve ser alterado.

## 9. Estado atual

Base implementada:

- GitHub: Alan-uai/Tradumanga
- Supabase: Tradumanga (voaavcicveaiitzbaogx)
- Vercel: tradumanga
- Figma: Tradumanga — UI/UX

Último commit conhecido:

6a3fa3157e51d1ed119bc5b1359f5b516c015a76

O build de produção correspondente foi confirmado como READY no Vercel.

Próxima etapa de implementação:

**Fase B — Orquestração de jobs**, começando por claim atômico, idempotência e recuperação de jobs.

## 10. Critério de conclusão

Uma fase só deve ser marcada como concluída quando:

- código está no GitHub;
- migration, quando aplicável, foi aplicada ao Supabase correto;
- build passa;
- fluxo principal da fase foi testado;
- falhas conhecidas estão documentadas;
- checkbox desta documentação é atualizado.
