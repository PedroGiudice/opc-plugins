# case-knowledge

Plugin Claude Code do Case Knowledge System: acesso aos documentos e a
memoria de sessoes de cada caso juridico, roteado pelo cwd da sessao
(`cases/<slug>/`).

## O que ele conecta

| Backend | Endereco | Papel |
|---|---|---|
| case-knowledge-api (Rust) | unix `127.0.0.1:8422`; Win via Tailscale `100.123.73.128:8422` | documentos do caso (collections `case-{slug}`) |
| legal-cogmem (Rust) | Win `https://cogmem.aidvlabs.com`; unix `100.123.73.128:3940` | memoria de sessoes (collections `case-{slug}-mem`) |

## Componentes

### MCP server (`server.mjs`)

Transporte stdio (obrigatorio para plugins Claude Code). Proxy HTTP para a
case-knowledge-api.

Deteccao de caso (`detectCase`): o cwd precisa estar sob `CASES_BASE`
(`CASE_KNOWLEDGE_CASES_BASE`; default Windows `%USERPROFILE%\cases`, fallback
`C:\Users\pedro\cases`; Unix `/home/opc/case-docs/cases`). O slug e o primeiro
componente do cwd relativo a base. Em paths Windows (drive letter), a
comparacao com a base e case-insensitive (NTFS); o nome do caso preserva o
casing original. Fora de caso, as tools que operam sobre um
caso retornam erro ("Sessao nao esta dentro de um caso"); `list_cases` continua
funcionando e lista os casos disponiveis.

Tools de documentos: `search`, `contexto`, `stats`, `list_cases`, `info`,
`manifesto`, `metadata`, `recommend`, `facet`, `comparar`, `discover`,
`buscar_cronologico`, `buscar_interseccao`, `buscar_diversificado`.

Tool de memoria: `memoria_search` (`memoria.mjs`) — busca dirigida na memoria
de sessoes do caso via `POST /api/search` do legal-cogmem. Roteada pelo
diretorio do caso (`repo_path`). Em falha (HTTP nao-ok, status nao-ok, daemon
fora) responde com texto `memoria indisponivel: ...`, sem quebrar a tool.

### Hook UserPromptSubmit (`hooks/memoria-context.mjs`)

Injeta um bloco `MEMORIA DO CASO [slug]` a cada prompt relevante via
`POST /api/context` do legal-cogmem. Gate identico ao do server (cwd sob
`CASES_BASE`); fora de caso nao gera trafego de rede. Filtra ainda prompts
triviais: menores que 15 caracteres, slash commands e respostas curtas
(`ok`, `sim`, `continua`, etc.).

Degrada gracioso: qualquer falha (timeout 2500ms, daemon fora, resposta
nao-ok) vira `{}` sem quebrar o Claude Code. O conteudo armazenado e integral;
a EXIBICAO no contexto e truncada em 1500 caracteres por chunk.

### Espelho de briefings (`sync-cases.mjs`)

Script standalone (nao e tool MCP nem hook) que espelha briefings de casos
da VM para a maquina cliente: `GET /cases/sync-manifest` -> compara md5
local -> baixa via `GET /cases/{name}/briefing` so o que mudou -> move
casos orfaos para `_archive/` (sufixo `-YYYYMMDD` em colisao). So escreve
nos arquivos de briefing (`CLAUDE.md`, `case.yaml`, `documentos.yaml`);
NUNCA deleta. Manifest vazio e tratado como erro do servidor (nao "arquive
tudo"). Matching de nome de caso e case-insensitive (NTFS): renomeio de
caixa na VM reusa o dir local em vez de duplicar. Agendado na cmr-002 via
Task Scheduler (a cada 5 min + logon, via sync-cases-hidden.vbs sem janela); exit 0 sempre — erros vao para
`~/cases/.sync.log` e o proximo ciclo e o retry. Usa as mesmas envs
`CASE_KNOWLEDGE_API_BASE` e `CASE_KNOWLEDGE_CASES_BASE`.

O mesmo script sobe, no fim do ciclo, os **transcripts de sessao** desta
maquina para o legal-cogmem (`POST /api/ingest-transcript`) — o watcher do
daemon so enxerga os JSONLs da VM.

**O que sobe:** so os dirs de `<home>/.claude/projects/` cujo nome comeca pelo
encode do `CASE_KNOWLEDGE_CASES_BASE` — o Claude Code encoda o path absoluto do
projeto trocando tudo que nao e alfanumerico por `-`, entao a base
`C:\Users\pedro\cases` vira o prefixo `C--Users-pedro-cases-`. A comparacao e
por PREFIXO (case-insensitive no Windows), nao por substring: um projeto em
`/home/opc/foo/cases-lib/` ou qualquer pasta com `cases` no meio do caminho
fica de fora. Na pratica: **sessao que nao roda dentro da sua pasta de casos
nao sai da maquina**. Sem base configurada, nada e elegivel (fail-closed).

Estado proprio em `.transcripts-state.json` (offset em bytes por arquivo),
gravado apos CADA request e so em 2xx: 500/401/413/rede fora mantem o offset e
o proximo ciclo reenvia (o reenvio e idempotente pelo dedupe do daemon). Caps:
3 MiB por request e 12 MiB por ciclo — arquivo maior continua no ciclo
seguinte. Entradas de arquivos que sumiram do disco sao podadas. Sem
credencial, o uploader loga uma linha e pula.

**Bloqueio por diretorio (`__blocked`).** Duas recusas do daemon sao
DETERMINISTICAS e valem para o DIRETORIO inteiro (todos os `.jsonl` dele tem o
mesmo `cwd`):

| Status | Natureza | Exemplo real |
|---|---|---|
| 400 | conteudo: o `cwd` do dir nao resolve para um slug de caso valido | pasta de trabalho local `~/cases/analise de relatorios` (espaco e acento) |
| 403 | estado do servidor: o caso nao pertence ao tenant | dir local `_spike-memoria`, ou caso que ainda nao existe na VM |

A recusa grava `__blocked: { "<dir>": { ts, status } }` e o dir sai inteiro do
plano — sem rede e sem leitura de disco. Sem isso, cada ciclo de 5 min
reenviaria as mesmas janelas e comeria o orcamento do ciclo para sempre
(medido na cmr-002: 6 dos 12 MiB). O offset NAO avanca (nada e dado como
capturado). Como o 403 depende do estado do servidor, o bloqueio tem **TTL de
6h**: vencido, exatamente UM arquivo do dir vai como sonda; se o caso passou a
existir/pertencer, o 2xx desbloqueia o dir todo. 401, 413 e 5xx sao
transitorios e NUNCA bloqueiam. Para forcar um retry antes das 6h, apague a
entrada de `__blocked`.

## Variaveis de ambiente

| Var | Default | Funcao |
|---|---|---|
| `CASE_KNOWLEDGE_API_BASE` | win32 `http://100.123.73.128:8422/api`; unix `http://127.0.0.1:8422/api` | API de documentos |
| `CASE_KNOWLEDGE_CASES_BASE` | win32 `%USERPROFILE%\cases` (fallback `C:\Users\pedro\cases`); unix `/home/opc/case-docs/cases` | base canonica dos casos (server E hook) |
| `LEGAL_COGMEM_API_BASE` | win32 `https://cogmem.aidvlabs.com/api`; unix `http://100.123.73.128:3940/api` | API de memoria (tool, hook e uploader de transcripts) |

No Windows (maquina cliente, fora da tailnet) o default do legal-cogmem e a
URL PUBLICA `https://cogmem.aidvlabs.com/api` — tunnel Cloudflare fail-closed
com path-filter: so `/api/context`, `/api/search`, `/api/ingest-transcript` e
`/api/health` passam pela borda; telemetria (`/api/events`, `/api/stats`,
`/api/sessions`, ...) fica tailnet-only. Na VM o default segue tailnet direto.
A env e soberana nas duas plataformas (a cmr-002 pode voltar ao tailnet
apontando `LEGAL_COGMEM_API_BASE=http://100.123.73.128:3940/api`).

Atencao ao customizar `CASE_KNOWLEDGE_CASES_BASE`: o daemon legal-cogmem
roteia memoria pelo componente `cases` do path enviado. Uma base SEM
`cases` no caminho (ex.: `/data/clientes`) passa no gate do plugin mas
recebe 400 do daemon em toda chamada de memoria — o hook degrada para `{}`
silenciosamente. Mantenha `cases` como componente do path da base.

## Testes

```bash
cd plugins/case-knowledge && node --test
```

## Release (disciplina obrigatoria)

O updater de plugins compara a VERSAO do `.claude-plugin/plugin.json`, nao o
SHA do marketplace. Toda mudanca neste plugin exige bump de versao no mesmo
commit. Nas maquinas consumidoras:

```bash
claude plugin marketplace update opc-plugins
claude plugin update case-knowledge@opc-plugins
```

Verificar a saida "updated from X to Y".

## Docs relacionadas

Arquitetura e runbooks do lado servidor:
`/home/opc/legal-cogmem/CLAUDE.md` e
`/home/opc/legal-cogmem/docs/runbooks/syncthing-espelho-transcripts.md`.

## Auth compartilhada (aidvlabs-mcp)

Os 3 plugins MCP (`case-knowledge`, `stj-vec-tools`, `legal-vec-tools`)
compartilham um unico login via keychain do SO (service `aidvlabs-mcp`,
account `default`). `auth.mjs` e uma copia byte-identica nos 3 (teste de
paridade `auth.parity.test.mjs`, dev-clone-only). O login e no app publico
`https://app.aidvlabs.com`; as tools batem nas APIs Rust.

### Smoke test (manual)

1. Login (grava a credencial compartilhada `aidvlabs-mcp`):
   `node plugins/case-knowledge/server.mjs login`
   -> abre o browser, consente, callback loopback, "Login concluido".

2. Os OUTROS dois NAO exigem novo login (leem a mesma entrada do keychain):
   `node -e 'import("./plugins/stj-vec-tools/auth.mjs").then(m=>console.log(!!m.readCredential()))'`
   -> `true`.

3. Bearer injetado (com API alcancavel via tailnet/publico): qualquer tool
   dos 3 responde 200 com `Authorization: Bearer`. Sem credencial, degrada
   para sem Bearer (compat tailnet `require_bearer=false`); so 401 efetivo
   pede login.

4. Concorrencia (D7): MCP + sync rotacionam sem revogar a family — lock
   `<dir-cred>/aidvlabs-mcp.lock` serializa (teste automatizado cobre).

### Testes

`cd plugins/<plugin> && node --test`
