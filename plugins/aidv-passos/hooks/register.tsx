import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

// ---------------------------------------------------------------------------
// aidv-passos: as ferramentas de BASTIDOR (Bash, Read, Write, Edit, Glob, Grep,
// Agent, Skill) viram uma frase em português no transcript. O que o modelo
// recebe NÃO muda: o mod só desenha, lendo `props.input` e `props.output`.
// ---------------------------------------------------------------------------

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Agent', 'Skill'] as const

const COR_DANGER = '#a3321f'
const COR_DOC = '#1f4f86'
const MAX_CAUDA = 12

const aberto = atom({ plugin: 'aidv-passos', key: 'aberto' } as const, {})
const grupos = atom({ plugin: 'aidv-passos', key: 'grupos' } as const, {})

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

type Passo = {
  feito: string
  rodando: string
  tecnico: string[]
  docx: Docx | null
  categoria: Categoria
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

function passoDe(tool: string, input: unknown, output: unknown): Passo {
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
    default:
      return {
        feito: `Usou ${tool}`,
        rodando: `Usando ${tool}…`,
        tecnico: [],
        docx: null,
        categoria: PESQUISAS.has(tool) ? 'pesquisas' : 'outros',
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
  for (const TOOL of TOOLS) {
    on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      const id = e.props.tool_use_id
      const passo = passoDe(e.props.tool, e.props.input, e.props.output)
      const largura = Math.max(40, (e.viewport?.columns ?? 100) - 12)

      if (e.props.isRunning) {
        return (
          <Box columnGap={1}>
            <Text dimColor>›</Text>
            <Text>{corta(passo.rodando, largura)}</Text>
          </Box>
        )
      }

      if (e.props.isInterrupted) {
        return (
          <Box columnGap={1}>
            <Text dimColor>›</Text>
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
            <Text color={COR_DOC}>■</Text>
            <Text bold>{corta(passo.feito, largura - 4)}</Text>
            <Text dimColor>{corta(passo.docx.caminho, Math.max(16, largura - passo.feito.length - 6))}</Text>
            {botao}
          </Box>
        )
      } else {
        linha = (
          <Box columnGap={1}>
            <Text dimColor>›</Text>
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

  // Grupo dobrado: "N passos de bastidor: 3 leituras, 1 documento, 2 comandos".
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const calls = e.props.calls
    const primeiro = calls[0]
    if (!primeiro || e.props.isExpanded) return next(e)
    const chave = primeiro.tool_use_id ?? `g-${calls.length}`
    const abertos = await read($, grupos)
    if (abertos[chave] === true) return next({ ...e, props: { ...e.props, isExpanded: true } })

    const falhas = calls.filter(c => c.isErrored).length
    const emCurso = e.props.isActive && calls.some(c => c.isRunning)
    return (
      <Box columnGap={1}>
        <Text dimColor>›</Text>
        <Text>
          {plural(calls.length, 'passo de bastidor', 'passos de bastidor')}
          {emCurso ? ' (em andamento)' : ''}:
        </Text>
        <Text dimColor>{resumoDoGrupo(calls)}</Text>
        {falhas > 0 ? <Text color={COR_DANGER}>{plural(falhas, 'falha', 'falhas')}</Text> : null}
        <Button key={`grupo-${chave}`} plain dimColor onPress={() => update($, grupos, g => ({ ...g, [chave]: true }))}>
          Mostrar passos
        </Button>
      </Box>
    )
  })
}
