import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

// ---------------------------------------------------------------------------
// aidv-passos: as ferramentas de BASTIDOR (Bash, Read, Write, Edit, Glob, Grep,
// Agent, Skill) viram uma frase em português no transcript. O que o modelo
// recebe NÃO muda: o mod só desenha, lendo `props.input` e `props.output`.
// ---------------------------------------------------------------------------

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Agent', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch'] as const

// Seção acrescentada ao system prompt: a frase do Bash vem do `description`
// que o modelo escreve; sem isto ele tende a escrevê-la em inglês.
const SECAO_PROMPT = {
  id: 'aidv-passos:descricoes',
  scope: 'session',
  text: [
    'Ao chamar as ferramentas Bash e Agent, escreva o campo `description` em português do Brasil,',
    'numa frase curta que um advogado sem formação técnica entenda, dizendo o que a operação faz',
    'pelo trabalho dele (ex.: "Gerar a contestação em .docx", "Listar os documentos do caso").',
    'Nunca em inglês e nunca repetindo o comando. Essa frase é mostrada ao usuário no lugar do comando.',
  ].join(' '),
} as const

// Paleta da identidade AiDV, a mesma do aidv-autos (7 tons do preset claro).
const COR_DANGER = '#a3321f'
const COR_INFO = '#1f4f86'
const COR_LAVENDER = '#5b3fa6'
const COR_OK = '#22603a'
const COR_WARN = '#8a4a0b'
const COR_PEACH = '#9a4312'
const COR_NEUTRAL = '#8a857d'
const COR_DOC = COR_INFO
const MAX_CAUDA = 12

const aberto = atom({ plugin: 'aidv-passos', key: 'aberto' } as const, {})

// ---------------------------------------------------------------------------
// Utilitários sem Node: o módulo roda num ambiente próprio.
// ---------------------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function campo(input: unknown, nome: string): string | null {
  return str(obj(input)[nome])
}

function basename(p: string): string {
  const limpo = p.replace(/[\\/]+$/, '')
  const i = Math.max(limpo.lastIndexOf('/'), limpo.lastIndexOf('\\'))
  return i >= 0 ? limpo.slice(i + 1) : limpo
}

function corta(s: string, max: number): string {
  const u = s.replace(/\s+/g, ' ').trim()
  return u.length > max ? u.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : u
}

function plural(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`
}

// Texto da saída: Bash resolve `{ stdout, stderr }`; chamada com erro resolve
// o texto que o modelo leu (string). Outras tools: o que der para ler.
function textoDaSaida(output: unknown): string {
  if (typeof output === 'string') return output
  const o = obj(output)
  const partes: string[] = []
  for (const k of ['stdout', 'stderr', 'text', 'content', 'message', 'error']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) partes.push(v)
    // Resultado MCP: `content: [{ type: 'text', text }]`.
    if (Array.isArray(v)) for (const item of v) if (typeof obj(item).text === 'string') partes.push(obj(item).text as string)
  }
  if (partes.length) return partes.join('\n')
  const file = obj(o.file)
  if (typeof file.content === 'string') return file.content
  return ''
}

function linhasUteis(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim().length > 0 && !/^\[rtk\]/.test(l))
}

function cauda(texto: string, max = MAX_CAUDA): string[] {
  const ls = linhasUteis(texto)
  const fim = ls.slice(-max).map(l => corta(l, 160))
  return ls.length > max ? ['…', ...fim] : fim
}

function primeiraLinhaDoErro(output: unknown): string {
  const o = obj(output)
  const stderr = typeof o.stderr === 'string' ? linhasUteis(o.stderr) : []
  const ls = stderr.length ? stderr : linhasUteis(textoDaSaida(output))
  // Num traceback a linha útil é a ÚLTIMA (a exceção); num erro de shell, a que nomeia o erro.
  const fortes = ls.filter(
    l => !/^Traceback/i.test(l) && /\b\w*(Error|Exception)\b|error:|\berro\b|fatal|not found|no such|permission denied|falhou/i.test(l),
  )
  const candidata = fortes.length ? fortes[fortes.length - 1] : /^Traceback/i.test(ls[0] ?? '') ? ls[ls.length - 1] : ls[0]
  return corta(candidata ?? '', 140)
}

// ---------------------------------------------------------------------------
// Objetos humanos: o que o arquivo É para o advogado, não onde está no disco.
// ---------------------------------------------------------------------------

function ehPastaDeCaso(p: string): boolean {
  return /[\\/]cases[\\/]/i.test(p)
}

function objetoDoArquivo(p: string): string {
  const base = basename(p)
  const caso = ehPastaDeCaso(p)
  if (base === 'CLAUDE.md') return caso ? 'o briefing do caso' : 'as instruções do projeto (CLAUDE.md)'
  if (base === 'MAPA_PROCESSUAL.md') return 'o mapa processual'
  if (base === 'case.yaml') return 'a ficha do caso'
  if (base === 'documentos.yaml') return 'o inventário de documentos'
  if (/[\\/]\.memoria[\\/]/.test(p) || base === 'MEMORY.md') return `a memória do caso (${base})`
  if (/\.docx$/i.test(base)) return `o documento ${base}`
  if (/\.(pdf)$/i.test(base)) return `o PDF ${base}`
  return `o arquivo ${base}`
}

function nomeDoRoteiro(skill: string): string {
  const semPlugin = skill.includes(':') ? skill.slice(skill.lastIndexOf(':') + 1) : skill
  return semPlugin.replace(/[-_]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// A frase de cada passo. `feito` no passado, `rodando` em curso; `tecnico` é a
// linha crua para "Detalhes"; `docx` marca o evento de documento gerado.
// ---------------------------------------------------------------------------

type Docx = { nome: string; caminho: string; aoLado: boolean }

type FonteJuridica = 'autos' | 'stj' | 'lei'

type Passo = {
  feito: string
  rodando: string
  tecnico: string[]
  docx: Docx | null
  categoria: Categoria
  fonte: FonteJuridica | null
}

// Glifo e cor da linha: fonte jurídica herda o vocabulário do aidv-autos
// (■ autos, ◈ STJ, § legislação); bastidor tem cor por categoria.
function marcaDe(p: Passo): { glifo: string; cor: string } {
  if (p.fonte === 'autos') return { glifo: '■', cor: COR_INFO }
  if (p.fonte === 'stj') return { glifo: '◈', cor: COR_LAVENDER }
  if (p.fonte === 'lei') return { glifo: '§', cor: COR_OK }
  switch (p.categoria) {
    case 'documentos':
      return { glifo: '■', cor: COR_DOC }
    case 'escritas':
      return { glifo: '›', cor: COR_PEACH }
    case 'comandos':
      return { glifo: '›', cor: COR_WARN }
    case 'tarefas delegadas':
      return { glifo: '›', cor: COR_LAVENDER }
    case 'pesquisas':
      return { glifo: '›', cor: COR_OK }
    default:
      return { glifo: '›', cor: COR_NEUTRAL }
  }
}

type Categoria =
  | 'leituras'
  | 'buscas em arquivos'
  | 'escritas'
  | 'comandos'
  | 'documentos'
  | 'tarefas delegadas'
  | 'roteiros'
  | 'pesquisas'
  | 'outros'

const PESQUISAS = new Set([
  'mcp__plugin_case-knowledge_case-knowledge__search',
  'mcp__plugin_stj-vec-tools_stj-vec-tools__search',
  'mcp__plugin_stj-vec-tools_stj-vec-tools__search_formula',
  'mcp__plugin_legal-vec-tools_legal-vec-tools__search',
])

function docxDaSaida(output: unknown): Docx | null {
  const texto = textoDaSaida(output)
  const guard = /gravada ao lado como:\s*'([^']+)'/.exec(texto)?.[1]
  if (guard) return { nome: basename(guard), caminho: guard, aoLado: true }
  const salvo = /^\s*Salvo:\s*(.+?\.docx)\s*$/im.exec(texto)?.[1]
  if (salvo) return { nome: basename(salvo), caminho: salvo, aoLado: false }
  return null
}

// ---------------------------------------------------------------------------
// Tools jurídicas que o aidv-autos NÃO desenha (ele cobre só `search`): aqui
// ganham uma frase cada. Nome da tool = server na grafia do Claude Code.
// ---------------------------------------------------------------------------

const CK = 'mcp__plugin_case-knowledge_case-knowledge__'
const STJ = 'mcp__plugin_stj-vec-tools_stj-vec-tools__'
const LEI = 'mcp__plugin_legal-vec-tools_legal-vec-tools__'

type Frase = { feito: string; rodando: string; categoria: Categoria }
type FraseDe = (input: unknown) => Frase

function texto(input: unknown, ...nomes: string[]): string | null {
  for (const n of nomes) {
    const v = campo(input, n)
    if (v) return v
  }
  return null
}

function aspas(q: string | null, max = 90): string {
  return q ? `: «${corta(q, max)}»` : ''
}

function fixa(feito: string, rodando: string, categoria: Categoria): FraseDe {
  return () => ({ feito, rodando, categoria })
}

function comQuery(feito: string, rodando: string, categoria: Categoria): FraseDe {
  return input => {
    const q = texto(input, 'query', 'q', 'texto', 'pergunta', 'tema')
    return { feito: `${feito}${aspas(q)}`, rodando: `${rodando}${aspas(q)}…`, categoria }
  }
}

function comObjeto(feito: string, rodando: string, categoria: Categoria, ...nomes: string[]): FraseDe {
  return input => {
    const o = texto(input, ...nomes)
    return { feito: o ? `${feito}: ${corta(o, 90)}` : feito, rodando: o ? `${rodando}: ${corta(o, 90)}…` : `${rodando}…`, categoria }
  }
}

const JURIDICAS: Record<string, FraseDe> = {
  [`${CK}memoria_search`]: comQuery('Consultou a memória do caso', 'Consultando a memória do caso', 'pesquisas'),
  [`${CK}metadata`]: fixa('Leu a ficha do caso', 'Lendo a ficha do caso…', 'leituras'),
  [`${CK}manifesto`]: fixa('Leu o índice dos autos', 'Lendo o índice dos autos…', 'leituras'),
  [`${CK}stats`]: fixa('Contou as peças dos autos', 'Contando as peças dos autos…', 'leituras'),
  [`${CK}info`]: fixa('Conferiu qual é o caso ativo', 'Conferindo o caso ativo…', 'leituras'),
  [`${CK}list_cases`]: fixa('Listou os casos', 'Listando os casos…', 'leituras'),
  [`${CK}document`]: comObjeto('Leu a peça inteira', 'Lendo a peça inteira', 'leituras', 'segmento', 'documento', 'segmento_id'),
  [`${CK}contexto`]: comObjeto('Leu o contexto de um trecho', 'Lendo o contexto de um trecho', 'leituras', 'documento'),
  [`${CK}facet`]: comObjeto('Mapeou os valores de', 'Mapeando os valores de', 'leituras', 'field', 'campo'),
  [`${CK}reconstruir`]: comQuery('Reconstruiu os autos sobre', 'Reconstruindo os autos sobre', 'leituras'),
  [`${CK}buscar_cronologico`]: comQuery('Pesquisou nos autos em ordem cronológica', 'Pesquisando nos autos em ordem cronológica', 'pesquisas'),
  [`${CK}buscar_diversificado`]: comQuery('Pesquisou nos autos por documento', 'Pesquisando nos autos por documento', 'pesquisas'),
  [`${CK}buscar_interseccao`]: comQuery('Pesquisou nos autos dois temas juntos', 'Pesquisando nos autos dois temas juntos', 'pesquisas'),
  [`${CK}comparar`]: fixa('Comparou peças dos autos', 'Comparando peças dos autos…', 'leituras'),
  [`${CK}cross_ref`]: comObjeto('Procurou onde os autos citam', 'Procurando onde os autos citam', 'pesquisas', 'valor', 'item', 'query'),
  [`${CK}discover`]: comQuery('Explorou os autos', 'Explorando os autos', 'pesquisas'),
  [`${CK}recommend`]: fixa('Buscou trechos parecidos nos autos', 'Buscando trechos parecidos nos autos…', 'pesquisas'),
  [`${STJ}document`]: comObjeto('Leu o inteiro teor', 'Lendo o inteiro teor', 'leituras', 'doc_id', 'processo'),
  [`${STJ}filters`]: fixa('Listou os filtros do STJ', 'Listando os filtros do STJ…', 'leituras'),
  [`${LEI}document`]: comObjeto('Leu o dispositivo', 'Lendo o dispositivo', 'leituras', 'doc_id'),
  [`${LEI}sources`]: fixa('Listou as fontes da legislação', 'Listando as fontes da legislação…', 'leituras'),
  [`${LEI}recommend`]: fixa('Buscou dispositivos parecidos', 'Buscando dispositivos parecidos…', 'pesquisas'),
}

function inputCompacto(input: unknown): string[] {
  const o = obj(input)
  const pares = Object.entries(o)
    .filter(([k]) => k !== 'tool' && k !== 'tool_use_id')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return pares.length ? [corta(pares.join(' · '), 300)] : []
}

function fonteDe(tool: string): FonteJuridica | null {
  if (tool.startsWith(CK)) return 'autos'
  if (tool.startsWith(STJ)) return 'stj'
  if (tool.startsWith(LEI)) return 'lei'
  return null
}

function passoDe(tool: string, input: unknown, output: unknown): Passo {
  return { ...passoBase(tool, input, output), fonte: fonteDe(tool) }
}

function passoBase(tool: string, input: unknown, output: unknown): Omit<Passo, 'fonte'> {
  const cmd = campo(input, 'command')
  switch (tool) {
    case 'Bash': {
      const descricao = campo(input, 'description')
      const docx = docxDaSaida(output)
      const tecnico = cmd ? [`$ ${corta(cmd, 300)}`] : []
      if (docx) {
        return {
          feito: docx.aoLado
            ? `Gravou o documento ao lado: ${docx.nome} (o original foi preservado)`
            : `Montou o documento ${docx.nome}`,
          rodando: descricao ? `${descricao}…` : 'Rodando um comando…',
          tecnico: [...tecnico, docx.caminho],
          docx,
          categoria: 'documentos',
        }
      }
      return {
        feito: descricao ?? 'Rodou um comando',
        rodando: descricao ? `${descricao}…` : 'Rodando um comando…',
        tecnico,
        docx: null,
        categoria: 'comandos',
      }
    }
    case 'Read': {
      const p = campo(input, 'file_path') ?? ''
      const parte = obj(input).offset !== undefined || obj(input).limit !== undefined ? ' (um trecho)' : ''
      return {
        feito: `Leu ${objetoDoArquivo(p)}${parte}`,
        rodando: `Lendo ${objetoDoArquivo(p)}…`,
        tecnico: [p],
        docx: null,
        categoria: 'leituras',
      }
    }
    case 'Write': {
      const p = campo(input, 'file_path') ?? ''
      const conteudo = campo(input, 'content') ?? ''
      return {
        feito: `Escreveu ${objetoDoArquivo(p)}`,
        rodando: `Escrevendo ${objetoDoArquivo(p)}…`,
        tecnico: [p, `${conteudo.length} caracteres`],
        docx: null,
        categoria: 'escritas',
      }
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = campo(input, 'file_path') ?? ''
      const velho = campo(input, 'old_string')
      const novo = campo(input, 'new_string')
      const tecnico = [p]
      if (velho) tecnico.push(`- ${corta(velho, 140)}`)
      if (novo) tecnico.push(`+ ${corta(novo, 140)}`)
      return {
        feito: `Alterou ${objetoDoArquivo(p)}`,
        rodando: `Alterando ${objetoDoArquivo(p)}…`,
        tecnico,
        docx: null,
        categoria: 'escritas',
      }
    }
    case 'Glob': {
      const padrao = campo(input, 'pattern') ?? ''
      const onde = campo(input, 'path')
      return {
        feito: `Procurou arquivos: ${padrao}`,
        rodando: `Procurando arquivos: ${padrao}…`,
        tecnico: onde ? [`${padrao} em ${onde}`] : [padrao],
        docx: null,
        categoria: 'buscas em arquivos',
      }
    }
    case 'Grep': {
      const padrao = campo(input, 'pattern') ?? ''
      const onde = campo(input, 'path')
      const glob = campo(input, 'glob')
      return {
        feito: `Procurou no texto: «${corta(padrao, 60)}»`,
        rodando: `Procurando no texto: «${corta(padrao, 60)}»…`,
        tecnico: [[padrao, onde ? `em ${onde}` : null, glob ? `(${glob})` : null].filter(Boolean).join(' ')],
        docx: null,
        categoria: 'buscas em arquivos',
      }
    }
    case 'Agent': {
      const descricao = campo(input, 'description') ?? 'uma tarefa'
      const tipo = campo(input, 'subagent_type')
      return {
        feito: `Delegou uma tarefa: ${descricao}`,
        rodando: `Delegando uma tarefa: ${descricao}…`,
        tecnico: tipo ? [`agente ${tipo}`] : [],
        docx: null,
        categoria: 'tarefas delegadas',
      }
    }
    case 'Skill': {
      const skill = campo(input, 'skill') ?? ''
      return {
        feito: `Carregou o roteiro: ${nomeDoRoteiro(skill)}`,
        rodando: `Carregando o roteiro: ${nomeDoRoteiro(skill)}…`,
        tecnico: [skill],
        docx: null,
        categoria: 'roteiros',
      }
    }
    case 'ToolSearch':
      return {
        feito: 'Carregou ferramentas',
        rodando: 'Carregando ferramentas…',
        tecnico: inputCompacto(input),
        docx: null,
        categoria: 'outros',
      }
    case 'WebFetch': {
      const url = campo(input, 'url') ?? ''
      const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? url
      return {
        feito: `Consultou a página: ${corta(host, 60)}`,
        rodando: `Consultando a página: ${corta(host, 60)}…`,
        tecnico: [url],
        docx: null,
        categoria: 'pesquisas',
      }
    }
    case 'WebSearch': {
      const q = campo(input, 'query') ?? ''
      return {
        feito: `Pesquisou na internet${aspas(q)}`,
        rodando: `Pesquisando na internet${aspas(q)}…`,
        tecnico: inputCompacto(input),
        docx: null,
        categoria: 'pesquisas',
      }
    }
    default: {
      const juridica = JURIDICAS[tool]
      if (juridica) {
        const f = juridica(input)
        return { ...f, tecnico: inputCompacto(input), docx: null }
      }
      return {
        feito: `Usou ${tool}`,
        rodando: `Usando ${tool}…`,
        tecnico: inputCompacto(input),
        docx: null,
        categoria: PESQUISAS.has(tool) ? 'pesquisas' : 'outros',
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grupo ("Used N tools"): contagem por categoria.
// ---------------------------------------------------------------------------

const ORDEM: Categoria[] = [
  'leituras',
  'documentos',
  'escritas',
  'comandos',
  'buscas em arquivos',
  'pesquisas',
  'tarefas delegadas',
  'roteiros',
  'outros',
]

const SINGULAR: Record<Categoria, string> = {
  leituras: 'leitura',
  'buscas em arquivos': 'busca em arquivos',
  escritas: 'escrita',
  comandos: 'comando',
  documentos: 'documento',
  'tarefas delegadas': 'tarefa delegada',
  roteiros: 'roteiro',
  pesquisas: 'pesquisa',
  outros: 'outro',
}

function resumoDoGrupo(calls: ReadonlyArray<{ tool: string; input: unknown; output?: unknown }>): string {
  const contagem = new Map<Categoria, number>()
  for (const c of calls) {
    const cat = passoDe(c.tool, c.input, c.output).categoria
    contagem.set(cat, (contagem.get(cat) ?? 0) + 1)
  }
  return ORDEM.filter(c => contagem.has(c))
    .map(c => plural(contagem.get(c) ?? 0, SINGULAR[c], c))
    .join(', ')
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export const register: Register = on => {
  // A descrição do Bash/Agent é a frase da linha: pede ao modelo que a escreva em português.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, SECAO_PROMPT] }
  })

  for (const TOOL of [...TOOLS, ...Object.keys(JURIDICAS)]) {
    on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      const id = e.props.tool_use_id
      const passo = passoDe(e.props.tool, e.props.input, e.props.output)
      const largura = Math.max(40, (e.viewport?.columns ?? 100) - 12)
      const marca = marcaDe(passo)

      if (e.props.isRunning) {
        return (
          <Box columnGap={1}>
            <Text color={marca.cor}>{marca.glifo}</Text>
            <Text>{corta(passo.rodando, largura)}</Text>
          </Box>
        )
      }

      if (e.props.isInterrupted) {
        return (
          <Box columnGap={1}>
            <Text dimColor>{marca.glifo}</Text>
            <Text dimColor>Interrompido: {corta(passo.feito, largura - 14)}</Text>
          </Box>
        )
      }

      const abertos = await read($, aberto)
      const estaAberto = abertos[id] === true
      const botao = (
        <Button key={`det-${id}`} plain dimColor onPress={() => update($, aberto, a => ({ ...a, [id]: !a[id] }))}>
          {estaAberto ? 'Ocultar' : 'Detalhes'}
        </Button>
      )

      let linha: RenderElement
      if (e.props.isErrored) {
        linha = (
          <Box columnGap={1}>
            <Text color={COR_DANGER}>×</Text>
            <Text color={COR_DANGER} bold>Falhou:</Text>
            <Text>{corta(passo.feito, Math.max(20, largura - 40))}</Text>
            <Text dimColor>{primeiraLinhaDoErro(e.props.output)}</Text>
            {botao}
          </Box>
        )
      } else if (passo.docx) {
        linha = (
          <Box columnGap={1}>
            <Text color={marca.cor}>{marca.glifo}</Text>
            <Text bold>{corta(passo.feito, largura - 4)}</Text>
            <Text dimColor>{corta(passo.docx.caminho, Math.max(16, largura - passo.feito.length - 6))}</Text>
            {botao}
          </Box>
        )
      } else {
        linha = (
          <Box columnGap={1}>
            <Text color={marca.cor}>{marca.glifo}</Text>
            <Text>{corta(passo.feito, largura)}</Text>
            {botao}
          </Box>
        )
      }

      if (!estaAberto) return linha

      // Em grupo o Desktop não desenha o site ToolResult: o detalhe vive aqui.
      const saida = cauda(textoDaSaida(e.props.output))
      return (
        <Box flexDirection="column">
          {linha}
          <Box flexDirection="column" paddingLeft={2}>
            {passo.tecnico.map((t, i) => (
              <Text key={`t-${id}-${i}`} dimColor>
                {corta(t, largura)}
              </Text>
            ))}
            {saida.map((l, i) => (
              <Text key={`s-${id}-${i}`} dimColor>
                {l}
              </Text>
            ))}
          </Box>
        </Box>
      )
    })

    // Bloco do resultado (só existe fora de grupo): o conteúdo técnico vive em "Detalhes".
    on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }

  // Cabeçalho do grupo enquanto o host o mostra dobrado/vivo: só informa.
  // NUNCA reescrever `isExpanded` por botão: no Desktop o grupo reescrito
  // desenha vazio (as linhas somem) — medido em 06/10/2026. Grupo já
  // expandido fica com o desenho nativo.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const calls = e.props.calls
    if (calls.length === 0 || e.props.isExpanded) return next(e)

    const falhas = calls.filter(c => c.isErrored).length
    const emCurso = e.props.isActive && calls.some(c => c.isRunning)
    return (
      <Box columnGap={1}>
        <Text dimColor>›</Text>
        <Text>
          {plural(calls.length, 'operação', 'operações')}
          {emCurso ? ' (em andamento)' : ''}:
        </Text>
        <Text dimColor>{resumoDoGrupo(calls)}</Text>
        {falhas > 0 ? <Text color={COR_DANGER}>{plural(falhas, 'falha', 'falhas')}</Text> : null}
      </Box>
    )
  })
}
