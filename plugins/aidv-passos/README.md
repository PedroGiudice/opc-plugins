# aidv-passos

Mod do Claude Code (plugin de hooks de função) que desenha as ferramentas de
BASTIDOR na linguagem do AiDV: uma frase em português por operação, em vez do
comando cru, do caminho de disco ou de "Used plugin x: y". Complementa o
`aidv-autos`, que cobre as pesquisas (`search`) nas três fontes jurídicas.

| Tool | Linha | Glifo |
|---|---|---|
| `Bash`, `PowerShell` | a `description` que o modelo escreveu; sem ela, "Rodou um comando" (nunca adivinha) | › âmbar |
| `Bash` com `Salvo: <x>.docx` no stdout (geradores CMR) | "Montou o documento x.docx" + caminho; guard de sobrescrita: "Gravou o documento ao lado" | ■ azul |
| `Read` | "Leu o briefing do caso" / "o mapa processual" / "a ficha do caso" / "o documento X" / "o arquivo X"; "Viu a imagem pg3.png"; "Leu o PDF X, págs. 1 a 6"; "Leu o restante de um resultado grande: peça inteira" (arquivo de `tool-results/`); "Leu o material de apoio do roteiro de revisão contratual"; memória: "Leu o índice da memória do caso" / "Leu a anotação da memória: nome" | › cinza |
| `Write`, `Edit`, `MultiEdit` | pasta do caso: "Salvou na pasta do caso: X" / "Alterou na pasta do caso: X" (o arquivo circula para os colegas); rascunho da sessão: "Escreveu um arquivo de trabalho temporário: X"; briefing/mapa/ficha/inventário: frase própria | › terracota |
| `Write`/`Edit` em `.memoria/` ou `.feedback/` | "Anotou na memória do caso: <description do frontmatter>"; orientação (`type: feedback`, ou nome `feedback_` sem type, a regra do `memFileType` do sync): "Anotou uma orientação para todos os casos: …"; `MEMORY.md`: "Atualizou o índice da memória do caso"; edição: "Atualizou a anotação da memória: nome" | › terracota |
| `Glob`, `Grep` | "Procurou arquivos: p" / "Procurou no texto: «p»" | › cinza |
| `Agent` | por tipo: "Pediu uma tradução: …" (`tradutor`), "Pediu uma pesquisa jurídica: …", "Pediu uma análise dos autos: …", "Pediu a leitura de páginas da internet: …"; demais "Delegou uma tarefa: description" | › lavanda |
| `Skill` | roteiros do escritório pelo nome: "Abriu o roteiro de geração de peças do CMR", "Abriu as ferramentas de documento Word"...; desconhecido: "Carregou o roteiro: nome" | › cinza |
| `ToolSearch` | "Carregou ferramentas", em cinza (sem valor para o advogado) | › cinza |
| `WebFetch`, `WebSearch` | sites oficiais pelo nome ("Consultou o site do Planalto (legislação federal)", "Consultou o e-SAJ do TJSP"); demais "Consultou a página: host" / "Pesquisou na internet: «q»" | › verde |
| `SendUserFile` | "Elaborou o documento X.docx" / "a planilha X.xlsx" / "2 arquivos: X e Y"; legenda em Detalhes. O bloco de resultado fica nativo. No Desktop a entrega é desenhada por componente próprio (legenda + cartão do arquivo, medido 10/10/2026): a linha não aparece lá e o cartão segue intacto; vale no terminal | ■ azul |
| Navegador (`claude-in-chrome`, `Claude_Browser`) | "No navegador: <action_summary do modelo>" (inicial minúscula, resto intacto); sem resumo: "olhou a tela", "esperou a página", "clicou na página", "abriu host", "procurou «q» na página", "rodou um script na página"; lote: "No navegador: 3 ações · <principal>". O bloco de resultado fica nativo (print da tela) | › azul |
| `Artifact`, capítulo, sessões anteriores, `TaskStop` | "Publicou a página: …", "Marcou um novo capítulo: …", "Consultou sessões anteriores", "Interrompeu uma tarefa em segundo plano" | › cinza |
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
pedindo ao modelo a `description` do Bash/PowerShell/Agent em português, para leigo,
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
