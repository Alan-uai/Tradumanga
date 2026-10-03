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
- Inngest para tarefas pesadas/assíncronas
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
- anonymous_sessions (ou mecanismo equivalente)
- user_work_state
- user_reading_history
- migration_events/idempotency para sincronização anônima → conta


### 4.1 Modelo de acesso: tradução sem login e persistência com login

A tradução deve ser acessível sem autenticação. O login não pode bloquear o fluxo principal de importar/analisar/traduzir/ler uma obra.

A separação de responsabilidades será:

| Ação | Sem login | Com login |
|---|---|---|
| Iniciar tradução | Permitido | Permitido |
| Acompanhar processamento | Permitido | Permitido |
| Ler obra traduzida | Permitido | Permitido |
| Registrar automaticamente que a obra foi traduzida | Persistido localmente | Persistido no banco |
| Registrar obras lidas/progresso | Persistido localmente | Persistido no banco |
| Bookmark/salvar obra | Estado local pode ser mantido como pendência | Salvo e persistido no banco |
| Favoritar obra | Estado local pode ser mantido como pendência | Salvo e persistido no banco |
| Histórico de traduções | Persistido localmente | Persistido no banco |
| Sincronizar histórico/biblioteca entre dispositivos | Não | Sim |

O sistema nunca deve perguntar ao usuário quais obras ele traduziu, leu ou marcou anteriormente. Esses eventos devem ser capturados automaticamente durante o uso.

#### Identidade anônima

- Cada navegador/dispositivo recebe uma identificação anônima opaca e aleatória, sem representar a identidade civil do usuário.
- O identificador da sessão anônima deve ser armazenado em cookie seguro; não usar dados pessoais ou um e-mail como identificador.
- O cliente mantém um registro local estruturado das obras e eventos anônimos.
- IndexedDB deve ser a persistência principal para esse estado estruturado; localStorage pode guardar somente metadados leves/manifesto quando apropriado.
- O estado local deve conter IDs/fingerprints necessários para reencontrar a obra, status da tradução, progresso de leitura, timestamps e ações pendentes de biblioteca.
- O servidor deve conseguir associar os artefatos de uma tradução anônima à sessão anônima sem exigir auth.uid().

#### Login e migração automática

Ao autenticar:

1. a aplicação detecta automaticamente a existência de estado anônimo local;
2. envia um manifesto de migração idempotente para o backend;
3. o backend resolve cada obra pelo identificador persistente disponível, priorizando fingerprint/hash e URL canônica quando aplicável;
4. obras, traduções concluídas, bookmarks, favoritos e histórico de leitura são associados ao user_id;
5. eventos duplicados não devem gerar registros duplicados;
6. conflitos devem ser resolvidos por identidade da obra e por timestamps/eventos, sem apagar dados válidos;
7. somente após confirmação do servidor o cliente marca os itens locais como sincronizados;
8. o estado local pode permanecer como cache para continuidade offline, mas deixa de ser a fonte de verdade do usuário autenticado.

A migração deve ser segura para repetição: recarregar a página, repetir o login ou reenviar o manifesto não pode duplicar biblioteca, histórico ou traduções.

#### Separação entre conteúdo e biblioteca do usuário

A existência de uma tradução não deve depender da existência de uma conta.

O modelo deve separar:

- conteúdo/artefatos da obra e da tradução;
- identidade/sessão anônima que está processando ou acessando esse conteúdo;
- estado pessoal do usuário: bookmark, favorito, histórico, progresso e obras traduzidas.

Isso evita transformar manga_series.owner_id em uma dependência para o fluxo de tradução anônima e permite que a mesma obra/artefato seja reconhecida após o login.

#### Banco de dados

A próxima migration de autenticação/persistência deverá revisar o schema atual e as RLS para suportar o fluxo anônimo com segurança.

Entidades planejadas:

- anonymous_sessions ou mecanismo equivalente para identificar sessões anônimas;
- user_work_state para bookmark, favorito, tradução concluída e metadados resumidos da obra;
- user_reading_history para histórico/progresso de leitura;
- migration_events/idempotency keys para impedir duplicação durante a migração.

As tabelas existentes de manga_series, chapters, pages e translation_jobs deverão ser ajustadas somente onde necessário para que uma sessão anônima possa criar e processar uma tradução com segurança.

RLS deve distinguir explicitamente:

- conteúdo público/anonimamente acessível necessário para tradução e leitura;
- recursos pertencentes a uma sessão anônima específica;
- dados pessoais pertencentes exclusivamente ao auth.uid();
- operações internas do worker usando service role.

Nunca abrir tabelas pessoais com USING/WITH CHECK true apenas para viabilizar o fluxo anônimo.

#### Regra de UX

O usuário deve conseguir chegar à tradução sem uma tela de login obrigatória.

O pedido de autenticação deve aparecer somente quando uma funcionalidade realmente exigir persistência de conta, por exemplo:

- Salvar bookmark;
- Favoritar;
- Sincronizar seu histórico;
- Salvar suas obras traduzidas na conta.

Quando o usuário fizer login, a sincronização deve acontecer automaticamente, sem formulário perguntando quais obras devem ser importadas.

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
- [x] Autenticação disponível
- [x] tradução sem login como fluxo principal
- [x] sessão anônima segura
- [x] persistência local de obras traduzidas/lidas e progresso
- [x] migração automática do estado anônimo após login
- [x] Dashboard
- [x] Criação de obra
- [x] Upload de capítulo/páginas
- [x] Endpoint inicial Gemini
- [x] Deploy Vercel funcional

### Fase B — Orquestração (Inngest)

- [x] fila de jobs transacionais
- [x] claim atômico com SKIP LOCKED
- [x] retry/recovery de jobs
- [x] processamento por página
- [x] criação/idempotência do job de processamento por capítulo
- [x] idempotência
- [x] observabilidade de status e erros no fluxo do capítulo

Implementado nesta fase:

- endpoint /api/inngest servido pelo Next.js;
- funções duráveis para ingestão, análise, contexto, tradução, renderização e QA;
- fan-out por página usando eventos idempotentes;
- retries gerenciados pelo Inngest;
- concorrência global compartilhada limitada a 5 etapas simultâneas;
- Supabase permanece como fonte de verdade para obras, capítulos, páginas, análises e artefatos;
- a tabela translation_jobs permanece apenas para compatibilidade/histórico e não é mais consumida pelo runtime.

A execução pesada saiu do worker Docker e passou para funções Node.js hospedadas na Vercel e orquestradas pelo Inngest.

### Fase C — Ingestão e cache

- [x] canonicalização de URLs
- [x] identificação do tipo de fonte
- [x] download de originais
- [x] SHA-256
- [ ] deduplicação por URL/hash
- [ ] reutilização de capítulos e imagens já importados
- [x] versionamento dos artefatos

Entradas reais implementadas: imagens, PDF e URL. URLs são validadas contra SSRF básico, metadata HTML/URL é usada para identificar obra/capítulo e as imagens são baixadas diretamente em Node.js. PDF é rasterizado com pdf-to-img. Fontes que exigem JavaScript ou um extrator específico precisam de adaptador próprio; gallery-dl não faz mais parte do runtime.

### Fase D — Visão e OCR contextual

- [x] análise multimodal da página
- [x] identificação de balões e caixas
- [x] bounding boxes/polígonos
- [x] OCR
- [x] idioma de origem
- [x] direção de leitura
- [x] onomatopeias
- [x] texto vertical/horizontal
- [x] estilo aproximado
- [x] confiança
- [x] contexto visual
- [x] contexto narrativo

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

- [x] tradução para pt-BR
- [x] preservação de intenção
- [x] adequação de registro
- [x] naturalidade de diálogo
- [x] consistência de nomes/termos
- [x] glossário
- [x] notas de tradução
- [x] confidence
- [x] versionamento
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

### Fase I — Leitor e biblioteca do usuário

- [x] seleção de capítulo
- [x] navegação página a página
- [x] modo original/traduzido
- [x] indicador de processamento
- [ ] revisão de tradução
- [ ] edição de balões
- [ ] regeneração de uma página
- [ ] progresso do capítulo
- [ ] tradução sem login
- [ ] registro local automático de obras traduzidas
- [ ] registro local automático de obras lidas/progresso
- [ ] bookmark/salvar obra com login
- [ ] favoritos com login
- [ ] histórico de leitura com login
- [ ] biblioteca de obras traduzidas com login
- [ ] sincronização automática do estado anônimo após login
- [ ] idempotência da migração
- [ ] resolução de conflitos entre estado local e estado já existente na conta

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

### Implementação do fluxo completo de tradução

A branch atual implementa o caminho real, sem mock de processamento:

`entrada → criação de capítulo → ingestão → páginas originais → análise Gemini → Context Engine → tradução contextual → máscara → renderer determinístico → QA de pixels → Storage → Reader`.

Entradas aceitas pela UI:

- imagens múltiplas;
- PDF;
- URL de capítulo/volume.

As funções Inngest são responsáveis pelas operações pesadas. O renderer usa uma máscara derivada das regiões analisadas e verifica programaticamente que nenhuma diferença ocorreu fora dessa máscara. A página traduzida é sempre armazenada em artefato separado de `original_path`.

UI/UX: o Figma existente foi usado como referência de tokens e componentes, e uma tela editável `00 — Import` foi adicionada ao arquivo `Tradumanga — UI/UX`. A implementação web recebeu os estados correspondentes de importação, processamento e leitura.

Pendências para declarar a fase operacionalmente concluída: executar CI/build, sincronizar o endpoint com o Inngest Cloud, testar um capítulo real ponta a ponta, validar os artefatos renderizados visualmente, concluir deduplicação/reuso e fechar a revisão humana no Reader.



Base implementada:

- GitHub: Alan-uai/Tradumanga
- Supabase: Tradumanga (voaavcicveaiitzbaogx)
- Vercel: tradumanga
- Figma: Tradumanga — UI/UX

Último commit conhecido:

0f8a448c9d355fe51d39e7302e30f40a5c480927

O commit anterior, `6a3fa3157e51d1ed119bc5b1359f5b516c015a76`, foi confirmado como READY no Vercel. O commit atual contém a primeira parte da orquestração e aguarda a conclusão do novo build.

Próxima etapa:

**Validação operacional do pipeline completo**, seguida de deduplicação/reuso de fontes, revisão humana no Reader e observabilidade/escala. O worker e a experiência sem login já estão implementados na branch atual.

## 10. Critério de conclusão

Uma fase só deve ser marcada como concluída quando:

- código está no GitHub;
- migration, quando aplicável, foi aplicada ao Supabase correto;
- build passa;
- fluxo principal da fase foi testado;
- falhas conhecidas estão documentadas;
- checkbox desta documentação é atualizado.
