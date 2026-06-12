# case-knowledge

Plugin Claude Code do Case Knowledge System: acesso aos documentos e a
memoria de sessoes de cada caso juridico, roteado pelo cwd da sessao
(`cases/<slug>/`).

## O que ele conecta

| Backend | Endereco | Papel |
|---|---|---|
| case-knowledge-api (Rust) | unix `127.0.0.1:8422`; Win via Tailscale `100.123.73.128:8422` | documentos do caso (collections `case-{slug}`) |
| legal-cogmem (Rust) | `100.123.73.128:3940` | memoria de sessoes (collections `case-{slug}-mem`) |

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
Task Scheduler (logon + a cada 15 min); exit 0 sempre — erros vao para
`~/cases/.sync.log` e o proximo ciclo e o retry. Usa as mesmas envs
`CASE_KNOWLEDGE_API_BASE` e `CASE_KNOWLEDGE_CASES_BASE`.

## Variaveis de ambiente

| Var | Default | Funcao |
|---|---|---|
| `CASE_KNOWLEDGE_API_BASE` | win32 `http://100.123.73.128:8422/api`; unix `http://127.0.0.1:8422/api` | API de documentos |
| `CASE_KNOWLEDGE_CASES_BASE` | win32 `%USERPROFILE%\cases` (fallback `C:\Users\pedro\cases`); unix `/home/opc/case-docs/cases` | base canonica dos casos (server E hook) |
| `LEGAL_COGMEM_API_BASE` | `http://100.123.73.128:3940/api` | API de memoria (tool e hook) |

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
