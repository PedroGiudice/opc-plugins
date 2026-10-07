# aidv-passos

Mod do Claude Code (plugin de hooks de função) que desenha as ferramentas de
BASTIDOR na linguagem do AiDV: uma frase em português por operação, em vez do
comando cru, do caminho de disco ou de "Used plugin x: y". Complementa o
`aidv-autos`, que cobre as pesquisas (`search`) nas três fontes jurídicas.

| Tool | Linha | Glifo |
|---|---|---|
| `Bash` | a `description` que o modelo escreveu, com o verbo inicial conjugado ("Listar os arquivos" vira "Listou os arquivos"; em curso, "Listando os arquivos…"); sem ela, "Rodou um comando" (nunca adivinha) | › âmbar |
| `Bash` com `Salvo: <x>.docx` no stdout (geradores CMR) | "Montou o documento x.docx" + caminho; guard de sobrescrita: "Gravou o documento ao lado" | ■ azul |
| `Read` | "Leu o briefing do caso" / "o mapa processual" / "a ficha do caso" / "a memória do caso" / "o documento X" / "o arquivo X" | › cinza |
| `Write`, `Edit`, `MultiEdit` | "Escreveu X" / "Alterou X" | › terracota |
| `Glob`, `Grep` | "Procurou arquivos: p" / "Procurou no texto: «p»" | › cinza |
| `Agent` | "Delegou uma tarefa: description" | › lavanda |
| `Skill` | "Carregou o roteiro: nome" | › cinza |
| `ToolSearch` | "Carregou ferramentas" | › cinza |
| `WebFetch`, `WebSearch` | "Consultou a página: host" / "Pesquisou na internet: «q»" | › verde |
| case-knowledge fora da busca (`memoria_search`, `metadata`, `manifesto`, `document`, `contexto`, `facet`, `reconstruir`, `buscar_*`, ...) | "Consultou a memória do caso: «q»", "Leu a ficha do caso", "Leu o índice dos autos", "Leu a peça inteira: X"... | ■ azul |
| stj-vec-tools `document`, `filters` | "Leu o inteiro teor: X", "Listou os filtros do STJ" | ◈ lavanda |
| legal-vec-tools `document`, `sources`, `recommend` | "Leu o dispositivo: X", "Listou as fontes da legislação" | § verde |

Estados: em curso (gerúndio, sem botão); interrompido (linha apagada, no
infinitivo como a falha: "Interrompido ao ler o arquivo X"; Bash com
description não conjugável: "Interrompido: <descrição>"); erro
(`isErrored`): "× Falhou ao <infinitivo>" + a linha útil do erro (num
traceback, a última). "Detalhes" dobra na própria linha a linha técnica
(comando, caminho, trecho antigo/novo, input compacto) e a cauda da saída
(12 linhas). O bloco `ToolResult` é desenhado vazio: o conteúdo técnico vive
em "Detalhes".

## Falha no infinitivo (0.1.3)

"Falhou: Leu o índice dos autos" se contradiz. A frase de falha sai do
gerúndio da linha em curso, que toda frase fixa tem ("Lendo o índice dos
autos…" vira "× Falhou ao ler o índice dos autos"; `pondo` vira `pôr`).
Bash: sem `description`, "Falhou ao rodar um comando"; com `description` no
infinitivo, "Falhou ao <descrição>"; em outra forma, "Falhou: <descrição>"
como veio. Frase que não começa por gerúndio reconhecível cai em
"Falhou: <frase no passado>".

## Description do Bash conjugada (0.1.3)

O modelo escreve a `description` no infinitivo (a seção do prompt pede:
"Comece pelo verbo no infinitivo"); as demais linhas falam no passado. A
PRIMEIRA palavra é conjugada: passado na 3ª pessoa (-ar→-ou, -er→-eu,
-ir→-iu, mais a tabela de irregulares: fazer→fez, ver→viu, trazer→trouxe,
ter→teve, ir/ser→foi, pôr→pôs e compostos de -por, ler→leu…) e gerúndio
(-ar→-ando, -er→-endo, -ir→-indo, pôr→pondo). Só conjuga palavra feita só
de letras, com radical de 2+ letras ou na tabela. Não conjuga: não-verbos
comuns (qualquer, lugar, popular, regular, dólar…), `por` sem acento (é a
preposição; o verbo é `pôr`), palavra com acento gráfico (infinitivo não
leva, salvo `pôr`) e descrição em inglês (artigos e preposições do inglês
na frase). Nesses casos a `description` sai como veio: conjugar o verbo que
o modelo escreveu é permitido, inventar não.

## Cores (0.1.3)

Cor SÓ em glifo; o texto fica na cor do tema. A paleta é a mesma do
`aidv-autos`, em tons intermediários entre os presets claro e escuro do
AiDV, ~4,3:1 tanto no fundo claro quanto no escuro do Desktop (a 0.1.2 usava
os tons do preset claro e ficava entre 2,2:1 e 2,8:1 no escuro):

| Tom | Hex | Uso |
|---|---|---|
| info | `#517db0` | ■ autos, documento gerado |
| lavanda | `#836cc3` | ◈ STJ, tarefa delegada |
| ok | `#478761` | § legislação, pesquisa |
| warn | `#ab6c2f` | › comando |
| peach | `#b66536` | › escrita |
| danger | `#c05d4d` | (glifo de tom danger; usado no aidv-autos) |
| neutral | `#8a857d` | › leitura, busca em arquivo, roteiro, outros (5,0:1 no escuro, 3,7:1 no claro) |

Erro não usa hex: o × e a palavra "Falhou" (e a contagem de falhas do grupo
no terminal) vão na chave de tema `error` do Claude Code.

Grupo: SÓ no terminal o cabeçalho dobrado vira "N operações: 3 leituras,
1 documento, 2 comandos" (sem botão). No Desktop o grupo fica inteiro
nativo: lá o cabeçalho nativo é desenhado sempre e a árvore própria entrava
como linha extra duplicada (0.1.1), e reescrever `isExpanded` por botão
apagava as linhas (0.1.0). Medido em 06/10/2026; as linhas internas seguem
humanizadas em qualquer superfície.

`prompt.compose` acrescenta uma seção de sessão (`aidv-passos:descricoes`)
pedindo ao modelo a `description` do Bash/Agent em português, para leigo,
começando pelo verbo no infinitivo, sem repetir o comando. É a única coisa
do mod que toca o que o modelo lê; o JSON/texto das tools NÃO muda.

## Gotchas medidos

- Mod INSTALADO só desenha em sessão LOCAL do Desktop (engine na máquina da
  pessoa). Em sessão hospedada na VM por SSH, a cópia que o Desktop envia vem
  sem `hooks/` e sombreia a instalação local. Desenvolver pelo dev-mods da
  sessão (skill `plugin-authoring`).
- Em grupo de tools o Desktop desenha só o site `ToolUse`; o detalhe vive na
  linha.
- Gates: `claude plugin validate`, `tsc` contra o `.d.ts` da sessão e
  `claude plugin test` (`tests/passos.test.ts`, terminal + desktop).
