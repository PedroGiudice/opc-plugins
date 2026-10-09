# aidv-passos

Mod do Claude Code (plugin de hooks de função) que desenha as ferramentas de
BASTIDOR na linguagem do AiDV: uma frase em português por operação, em vez do
comando cru, do caminho de disco ou de "Used plugin x: y". Complementa o
`aidv-autos`, que cobre as pesquisas (`search`) nas três fontes jurídicas.

| Tool | Linha | Glifo |
|---|---|---|
| `Bash` | a `description` que o modelo escreveu; sem ela, "Rodou um comando" (nunca adivinha) | › âmbar |
| `Bash` com `Salvo: <x>.docx` no stdout (geradores CMR) | "Montou o documento x.docx" + caminho; guard de sobrescrita: "Gravou o documento ao lado" | ■ azul |
| `Read` | "Leu o briefing do caso" / "o mapa processual" / "a ficha do caso" / "a memória do caso" / "o documento X" / "o arquivo X" | › cinza |
| `Write`, `Edit`, `MultiEdit` | "Escreveu X" / "Alterou X" | › terracota |
| `Glob`, `Grep` | "Procurou arquivos: p" / "Procurou no texto: «p»" | › cinza |
| `Agent` | "Delegou uma tarefa: description" | › lavanda |
| `Skill` | "Carregou o roteiro: nome" | › cinza |
| `ToolSearch` | "Carregou ferramentas" | › cinza |
| `WebFetch`, `WebSearch` | "Consultou a página: host" / "Pesquisou na internet: «q»" | › verde |
| case-knowledge fora da busca (`memoria_search`, `metadata`, `manifesto`, `document`, `contexto`, `facet`, `reconstruir`, `buscar_*`, ...) | "Consultou a memória do caso: «q»", "Leu a ficha do caso", "Leu o índice dos autos", "Leu a peça inteira: Sentença · arquivo (pág. 9)"... | ■ azul |
| stj-vec-tools `document`, `filters` | "Leu o inteiro teor: AREsp 2132923 · acórdão, Terceira Turma, Min. Moura Ribeiro, julgamento em 12/12/2022", "Listou os filtros do STJ" | ◈ lavanda |
| legal-vec-tools `document`, `sources`, `recommend` | "Leu o dispositivo: CPC, art. 1012", "Listou as fontes da legislação" | § verde |

Leituras (0.1.3): a linha diz O QUE foi lido, copiando do resultado. Peça:
classe do cabeçalho `Peca:` da saída + arquivo sem `.json` + página do
`#pNNNN` do segmento. Julgado: `processo`, `tipo`, `orgao_julgador`,
`ministro` e `data_julgamento` (ou `data_publicacao`) do objeto `document`.
Dispositivo: rótulo pelo `doc_id` (`cpc_art_1012`, `sumula_stj_547`). O
identificador interno (doc_id, `<arquivo>.json#pNNNN`) nunca vai para a linha:
fica em "Detalhes"; em curso, ou com saída ilegível, a frase fica genérica
("Leu o inteiro teor de um julgado", "Leu um dispositivo"). O rótulo das
classes de peça é espelho do `PECAS` do aidv-autos.

Estados: em curso (gerúndio, sem botão); interrompido (apagado); erro
(`isErrored`): "× Falhou: frase" + a linha útil do erro (num traceback, a
última). "Detalhes" dobra na própria linha a linha técnica (comando, caminho,
trecho antigo/novo, input compacto) e a cauda da saída (12 linhas). O bloco
`ToolResult` é desenhado vazio: o conteúdo técnico vive em "Detalhes".

Grupo: SÓ no terminal o cabeçalho dobrado vira "N operações: 3 leituras,
1 documento, 2 comandos" (sem botão). No Desktop o grupo fica inteiro
nativo: lá o cabeçalho nativo é desenhado sempre e a árvore própria entrava
como linha extra duplicada (0.1.1), e reescrever `isExpanded` por botão
apagava as linhas (0.1.0). Medido em 06/10/2026; as linhas internas seguem
humanizadas em qualquer superfície.

`prompt.compose` acrescenta uma seção de sessão (`aidv-passos:descricoes`)
pedindo ao modelo a `description` do Bash/Agent em português, para leigo,
sem repetir o comando. É a única coisa do mod que toca o que o modelo lê;
o JSON/texto das tools NÃO muda.

## Gotchas medidos

- Mod INSTALADO só desenha em sessão LOCAL do Desktop (engine na máquina da
  pessoa). Em sessão hospedada na VM por SSH, a cópia que o Desktop envia vem
  sem `hooks/` e sombreia a instalação local. Desenvolver pelo dev-mods da
  sessão (skill `plugin-authoring`).
- Desenvolver pela VM com o mod JÁ instalado na máquina do Desktop: a sessão
  hospedada na VM recebe a cópia instalada SEM `hooks/`, com o mesmo nome, e
  ela vence a cópia do dev-mods (medido 09/10/2026: nada desenha, nenhum aviso).
  Contorno: no dev-mods, renomear o plugin para `<mod>-dev` (`name` do
  plugin.json, `plugin:` dos atoms, chave do `PluginState` em `types/` e
  `PLUGIN` dos testes) e desfazer a troca ao devolver o código ao dev clone.
- Em grupo de tools o Desktop desenha só o site `ToolUse`; o detalhe vive na
  linha.
- Gates: `claude plugin validate`, `tsc` contra o `.d.ts` da sessão e
  `claude plugin test` (`tests/passos.test.ts`, terminal + desktop).
