import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

// ---------------------------------------------------------------------------
// aidv-passos: as ferramentas de BASTIDOR (Bash, PowerShell, Read, Write,
// Edit, Glob, Grep, Agent, Skill, navegador, entrega de arquivo) viram uma
// frase em português no transcript. O que o modelo recebe NÃO muda (exceto a
// seção de prompt que pede a `description` em português): o mod só desenha,
// lendo `props.input` e `props.output`. Frases decididas pelo CEO sobre o
// inventário de 09/10/2026 (case-docs/docs/contexto/09102026-inventario-*).
// ---------------------------------------------------------------------------

const TOOLS = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Agent', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch'] as const

// Seção acrescentada ao system prompt: a frase do Bash vem do `description`
// que o modelo escreve; sem isto ele tende a escrevê-la em inglês.
const SECAO_PROMPT = {
  id: 'aidv-passos:descricoes',
  scope: 'session',
  text: [
    'Ao chamar as ferramentas Bash, PowerShell e Agent, escreva o campo `description` em português do Brasil,',
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
  // Linha em cinza: passo de infraestrutura sem valor para o advogado.
  discreto?: boolean
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
    case 'anotações':
      return { glifo: '›', cor: COR_PEACH }
    case 'ações no navegador':
      return { glifo: '›', cor: COR_INFO }
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
  | 'anotações'
  | 'ações no navegador'
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
// `output` só existe com a chamada concluída: a frase em curso vem do input.
type FraseDe = (input: unknown, output: unknown) => Frase

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

// ---------------------------------------------------------------------------
// Leituras: a linha diz O QUE foi lido, copiando do resultado (classe da peça,
// processo, órgão, relator, datas). O identificador interno da base (doc_id,
// `<arquivo>.json#pNNNN`) fica só em "Detalhes".
// ---------------------------------------------------------------------------

// Rótulo humano das classes de peça: espelho do `PECAS` do aidv-autos (mods
// não compartilham código; mudar lá exige mudar aqui).
const PECA_ROTULO: Record<string, string> = {
  inicial: 'Petição inicial',
  cumprimento_sentenca: 'Cumprimento de sentença',
  embargos_terceiro: 'Embargos de terceiro',
  incidente_desconsideracao_pj: 'Incidente de desconsideração da PJ',
  contestacao: 'Contestação',
  replica: 'Réplica',
  manifestacao: 'Manifestação',
  manifestacao_provas: 'Manifestação sobre provas',
  peticao_diversa: 'Petição diversa',
  alegacoes_finais: 'Alegações finais',
  impugnacao_cumprimento_sentenca: 'Impugnação ao cumprimento de sentença',
  embargos_execucao: 'Embargos à execução',
  excecao_preexecutividade: 'Exceção de pré-executividade',
  decisao_interlocutoria: 'Decisão interlocutória',
  despacho: 'Despacho',
  sentenca: 'Sentença',
  acordao: 'Acórdão',
  embargos_declaracao: 'Embargos de declaração',
  agravo: 'Agravo de instrumento',
  agravo_interno: 'Agravo interno',
  agravo_peticao: 'Agravo de petição',
  apelacao: 'Apelação',
  recurso_ordinario: 'Recurso ordinário',
  recurso_revista: 'Recurso de revista',
  recurso_especial: 'Recurso especial',
  recurso_extraordinario: 'Recurso extraordinário',
  contrarrazoes: 'Contrarrazões',
  ata_audiencia: 'Ata de audiência',
  acordo: 'Acordo',
  certidao: 'Certidão',
  mandado: 'Mandado',
  ato_ordinatorio: 'Ato ordinatório',
  procuracao: 'Procuração',
  contrato: 'Contrato',
  comprovante: 'Comprovante',
  nota_fiscal: 'Nota fiscal',
  guia_custas: 'Guia de custas',
  documento_pessoal: 'Documento pessoal',
  documento_societario: 'Documento societário',
  laudo: 'Laudo',
  demonstrativo_calculo: 'Demonstrativo de cálculo',
  trct: 'TRCT (rescisão)',
  contracheque: 'Contracheque',
  cartao_ponto: 'Cartão de ponto',
  ctps: 'CTPS',
  norma_coletiva: 'Norma coletiva',
  certidao_divida_ativa: 'Certidão de dívida ativa',
  certidao_extrajudicial: 'Certidão extrajudicial',
  auto_infracao: 'Auto de infração',
  outros_anexos: 'Outros anexos',
}

function rotuloDaPeca(peca: string): string {
  const classe = peca.split('/')[0] ?? peca
  return PECA_ROTULO[classe] ?? classe.replace(/_/g, ' ')
}

function semJson(nome: string): string {
  return nome.replace(/\.json$/i, '')
}

// `<arquivo>.json#p0009` -> o arquivo e a página do PDF onde o documento começa.
function alvoDoSegmento(seg: string): string {
  const m = /^(.*)#p(\d+)$/.exec(seg)
  return m && m[1] !== undefined && m[2] !== undefined ? `${semJson(m[1])} (pág. ${Number(m[2])})` : semJson(seg)
}

// Linha `Rotulo: valor` do cabeçalho da saída (antes da primeira linha em branco).
function doCabecalho(saida: string, rotulo: string): string | null {
  const cabecalho = saida.split(/\r?\n\r?\n/)[0] ?? ''
  return new RegExp(`^${rotulo}: (.+)$`, 'm').exec(cabecalho)?.[1]?.trim() || null
}

const pecaInteira: FraseDe = (input, output) => {
  const seg = texto(input, 'segmento', 'segmento_id')
  const doc = texto(input, 'documento')
  const alvo = seg ? alvoDoSegmento(seg) : doc ? semJson(doc) : null
  const peca = doCabecalho(textoDaSaida(output), 'Peca')
  const objeto = [peca ? rotuloDaPeca(peca) : null, alvo].filter(Boolean).join(' · ')
  return {
    feito: objeto ? `Leu a peça inteira: ${corta(objeto, 140)}` : 'Leu a peça inteira',
    rodando: alvo ? `Lendo a peça inteira: ${corta(alvo, 120)}…` : 'Lendo a peça inteira…',
    categoria: 'leituras',
  }
}

const contextoDoTrecho: FraseDe = input => {
  const doc = texto(input, 'documento')
  const alvo = doc ? `: ${corta(semJson(doc), 90)}` : ''
  return { feito: `Leu o contexto de um trecho${alvo}`, rodando: `Lendo o contexto de um trecho${alvo}…`, categoria: 'leituras' }
}

// "TERCEIRA TURMA" -> "Terceira Turma"; "LUIS FELIPE SALOMÃO" -> "Luis Felipe Salomão".
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
function nomeProprio(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (MINUSCULAS.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

function dataCurta(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

// Campo string do JSON da saída, lido por expressão para não depender do
// JSON inteiro (o inteiro teor é grande e pode vir cortado).
function campoJson(trecho: string, nome: string): string | null {
  const m = new RegExp(`"${nome}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(trecho)
  if (!m || m[1] === undefined) return null
  try {
    return (JSON.parse(`"${m[1]}"`) as string).trim() || null
  } catch {
    return m[1].trim() || null
  }
}

const TIPO_JULGADO: Record<string, string> = { 'ACÓRDÃO': 'acórdão', ACORDAO: 'acórdão', 'DECISÃO': 'decisão', DECISAO: 'decisão' }

const inteiroTeor: FraseDe = (input, output) => {
  const saida = textoDaSaida(output)
  const fim = saida.indexOf('"chunks"')
  // Só o objeto `document`, que vem antes dos chunks.
  const doc = fim >= 0 ? saida.slice(0, fim) : saida.slice(0, 2000)
  const processo = campoJson(doc, 'processo')
  const tipo = campoJson(doc, 'tipo')
  const orgao = campoJson(doc, 'orgao_julgador')
  const ministro = campoJson(doc, 'ministro')
  const julgamento = campoJson(doc, 'data_julgamento')
  const publicacao = campoJson(doc, 'data_publicacao')
  const dados = [
    tipo ? TIPO_JULGADO[tipo.toUpperCase()] ?? tipo.toLowerCase() : null,
    orgao ? nomeProprio(orgao) : null,
    ministro ? `Min. ${nomeProprio(ministro)}` : null,
    julgamento ? `julgamento em ${dataCurta(julgamento)}` : publicacao ? `publicação em ${dataCurta(publicacao)}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const pedido = texto(input, 'processo')
  return {
    feito: processo ? `Leu o inteiro teor: ${corta(dados ? `${processo} · ${dados}` : processo, 140)}` : 'Leu o inteiro teor de um julgado',
    rodando: pedido ? `Lendo o inteiro teor: ${corta(pedido, 60)}…` : 'Lendo o inteiro teor de um julgado…',
    categoria: 'leituras',
  }
}

const CODIGOS: Record<string, string> = {
  cf: 'CF', cc: 'CC', cpc: 'CPC', cdc: 'CDC', clt: 'CLT', cp: 'CP', cpp: 'CPP', eca: 'ECA', ctn: 'CTN',
  codigo_civil: 'Código Civil', codigo_penal: 'Código Penal', marco_seguros: 'Marco Legal dos Seguros',
}

// Rótulo do dispositivo pelo próprio doc_id (`cpc_art_1012`, `sumula_stj_547`);
// formato desconhecido = sem rótulo, nunca o id cru na linha.
function rotuloDoDispositivo(docId: string): string | null {
  const art = /^([a-z][a-z0-9_]*?)_art_([\w-]+)$/i.exec(docId)
  if (art && art[1] && art[2]) return `${CODIGOS[art[1].toLowerCase()] ?? art[1].replace(/_/g, ' ')}, art. ${art[2].replace(/_/g, '-')}`
  const sum = /^sumula_([a-z]+)_(\d+)$/i.exec(docId)
  if (sum && sum[1] && sum[2]) return `Súmula ${sum[2]} do ${sum[1].toUpperCase()}`
  return null
}

const dispositivo: FraseDe = input => {
  const id = texto(input, 'doc_id')
  const r = id ? rotuloDoDispositivo(id) : null
  return {
    feito: r ? `Leu o dispositivo: ${r}` : 'Leu um dispositivo',
    rodando: r ? `Lendo o dispositivo: ${r}…` : 'Lendo um dispositivo…',
    categoria: 'leituras',
  }
}

const JURIDICAS: Record<string, FraseDe> = {
  [`${CK}memoria_search`]: comQuery('Consultou a memória do caso', 'Consultando a memória do caso', 'pesquisas'),
  [`${CK}metadata`]: fixa('Leu a ficha do caso', 'Lendo a ficha do caso…', 'leituras'),
  [`${CK}manifesto`]: fixa('Leu o índice dos autos', 'Lendo o índice dos autos…', 'leituras'),
  [`${CK}stats`]: fixa('Contou as peças dos autos', 'Contando as peças dos autos…', 'leituras'),
  [`${CK}info`]: fixa('Conferiu qual é o caso ativo', 'Conferindo o caso ativo…', 'leituras'),
  [`${CK}list_cases`]: fixa('Listou os casos', 'Listando os casos…', 'leituras'),
  [`${CK}document`]: pecaInteira,
  [`${CK}contexto`]: contextoDoTrecho,
  [`${CK}facet`]: comObjeto('Mapeou os valores de', 'Mapeando os valores de', 'leituras', 'field', 'campo'),
  [`${CK}reconstruir`]: comQuery('Reconstruiu os autos sobre', 'Reconstruindo os autos sobre', 'leituras'),
  [`${CK}buscar_cronologico`]: comQuery('Pesquisou nos autos em ordem cronológica', 'Pesquisando nos autos em ordem cronológica', 'pesquisas'),
  [`${CK}buscar_diversificado`]: comQuery('Pesquisou nos autos por documento', 'Pesquisando nos autos por documento', 'pesquisas'),
  [`${CK}buscar_interseccao`]: comQuery('Pesquisou nos autos dois temas juntos', 'Pesquisando nos autos dois temas juntos', 'pesquisas'),
  [`${CK}comparar`]: fixa('Comparou peças dos autos', 'Comparando peças dos autos…', 'leituras'),
  [`${CK}cross_ref`]: comObjeto('Procurou onde os autos citam', 'Procurando onde os autos citam', 'pesquisas', 'valor', 'item', 'query'),
  [`${CK}discover`]: comQuery('Explorou os autos', 'Explorando os autos', 'pesquisas'),
  [`${CK}recommend`]: fixa('Buscou trechos parecidos nos autos', 'Buscando trechos parecidos nos autos…', 'pesquisas'),
  [`${STJ}document`]: inteiroTeor,
  [`${STJ}filters`]: fixa('Listou os filtros do STJ', 'Listando os filtros do STJ…', 'leituras'),
  [`${LEI}document`]: dispositivo,
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

// ---------------------------------------------------------------------------
// Memória do caso e pool de feedback. A regra de "orientação para todos os
// casos" espelha `memFileType` do sync-cases.mjs (case-knowledge): o
// frontmatter manda nos dois sentidos; sem `type` conhecido, o prefixo
// `feedback_` decide. É o sync que leva o arquivo ao pool do escritório.
// ---------------------------------------------------------------------------

const TIPOS_DE_MEMORIA = new Set(['project', 'reference', 'user'])

function frontmatter(content: string): string | null {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? null
}

function tipoDoFrontmatter(content: string): string | undefined {
  const fm = frontmatter(content)
  if (fm === null) return undefined
  let primeiro: string | undefined
  for (const l of fm.split(/\r?\n/)) {
    const v = /^\s*type:\s*["']?([A-Za-z_]+)["']?\s*(?:#.*)?$/.exec(l)?.[1]?.toLowerCase()
    if (!v) continue
    if (v === 'feedback') return 'feedback'
    primeiro ??= v
  }
  return primeiro
}

function ehOrientacao(nome: string, content: string | null): boolean {
  if (content !== null) {
    const t = tipoDoFrontmatter(content)
    if (t === 'feedback') return true
    if (t !== undefined && TIPOS_DE_MEMORIA.has(t)) return false
  }
  return nome.startsWith('feedback_')
}

function descricaoDoFrontmatter(content: string): string | null {
  const fm = frontmatter(content)
  const v = fm ? /^\s*description:\s*(.+?)\s*$/m.exec(fm)?.[1] : undefined
  if (!v) return null
  const semAspas = /^(["'])(.*)\1$/.exec(v)?.[2] ?? v
  return semAspas.replace(/\\"/g, '"').trim() || null
}

// "project-ed-gratuidade-adc80-modulacao.md" -> "ed gratuidade adc80 modulacao".
function nomeDaAnotacao(base: string): string {
  return base
    .replace(/\.md$/i, '')
    .replace(/^(project|feedback|reference|user)[-_]/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

function ehDaMemoria(p: string): boolean {
  return /[\\/]\.memoria[\\/]/.test(p) || /[\\/]\.feedback[\\/]/.test(p) || basename(p) === 'MEMORY.md'
}

function ehDoPool(p: string): boolean {
  return /[\\/]\.feedback[\\/]/.test(p)
}

type Escrita = { feito: string; rodando: string; categoria: Categoria }

function escritaNaMemoria(p: string, content: string | null, edicao: boolean): Escrita {
  const base = basename(p)
  if (base === 'MEMORY.md') {
    return { feito: 'Atualizou o índice da memória do caso', rodando: 'Atualizando o índice da memória do caso…', categoria: 'anotações' }
  }
  const nome = (content !== null ? descricaoDoFrontmatter(content) : null) ?? nomeDaAnotacao(base)
  const orientacao = ehDoPool(p) || ehOrientacao(base, content)
  if (edicao) {
    const alvo = orientacao ? 'uma orientação para todos os casos' : 'a anotação da memória'
    return { feito: `Atualizou ${alvo}: ${nome}`, rodando: `Atualizando ${alvo}: ${nome}…`, categoria: 'anotações' }
  }
  return orientacao
    ? { feito: `Anotou uma orientação para todos os casos: ${nome}`, rodando: 'Anotando uma orientação para todos os casos…', categoria: 'anotações' }
    : { feito: `Anotou na memória do caso: ${nome}`, rodando: 'Anotando na memória do caso…', categoria: 'anotações' }
}

// ---------------------------------------------------------------------------
// Onde o arquivo fica: a pasta do caso circula para os colegas (pool de
// workdocs); o rascunho da sessão é descartado.
// ---------------------------------------------------------------------------

const OBJETOS_FIXOS = new Set(['CLAUDE.md', 'MAPA_PROCESSUAL.md', 'case.yaml', 'documentos.yaml'])

function ehRascunho(p: string): boolean {
  return /[\\/]scratchpad[\\/]/i.test(p) || /appdata[\\/]local[\\/]temp[\\/]/i.test(p)
}

function ehPastaDoCasoDireta(p: string): boolean {
  return /[\\/]cases[\\/][^\\/.][^\\/]*[\\/]/i.test(p) && !ehRascunho(p)
}

function escritaDeArquivo(p: string, edicao: boolean): Escrita {
  const base = basename(p)
  if (!OBJETOS_FIXOS.has(base)) {
    if (ehPastaDoCasoDireta(p)) {
      return edicao
        ? { feito: `Alterou na pasta do caso: ${base}`, rodando: `Alterando na pasta do caso: ${base}…`, categoria: 'escritas' }
        : { feito: `Salvou na pasta do caso: ${base}`, rodando: `Salvando na pasta do caso: ${base}…`, categoria: 'escritas' }
    }
    if (ehRascunho(p)) {
      const v = edicao ? ['Alterou', 'Alterando'] : ['Escreveu', 'Escrevendo']
      return { feito: `${v[0]} um arquivo de trabalho temporário: ${base}`, rodando: `${v[1]} um arquivo de trabalho temporário: ${base}…`, categoria: 'escritas' }
    }
  }
  return edicao
    ? { feito: `Alterou ${objetoDoArquivo(p)}`, rodando: `Alterando ${objetoDoArquivo(p)}…`, categoria: 'escritas' }
    : { feito: `Escreveu ${objetoDoArquivo(p)}`, rodando: `Escrevendo ${objetoDoArquivo(p)}…`, categoria: 'escritas' }
}

// ---------------------------------------------------------------------------
// Leituras de arquivo com objeto próprio.
// ---------------------------------------------------------------------------

// Resultado de tool acima do limite do Claude Code vai para `tool-results/`
// com o nome `mcp-plugin_<server>_<server>-<tool>-<n>.txt`.
const RESULTADO_GRANDE: Record<string, string> = {
  'case-knowledge:document': 'peça inteira',
  'case-knowledge:contexto': 'contexto de um trecho',
  'case-knowledge:manifesto': 'índice dos autos',
  'case-knowledge:search': 'pesquisa nos autos',
  'case-knowledge:reconstruir': 'reconstrução dos autos',
  'stj-vec-tools:document': 'inteiro teor',
  'stj-vec-tools:search': 'pesquisa no STJ',
  'legal-vec-tools:search': 'pesquisa na legislação',
  'legal-vec-tools:document': 'dispositivo',
}

function rotuloDoResultadoGrande(base: string): string | null {
  const m = /^mcp-plugin_([a-z0-9-]+?)_\1-([a-z_]+)-\d+\./i.exec(base)
  if (m && m[1] && m[2]) return RESULTADO_GRANDE[`${m[1]}:${m[2]}`] ?? null
  if (/^webfetch-/i.test(base)) return 'documento baixado da internet'
  return null
}

function paginas(pages: string): string {
  const intervalo = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(pages)
  if (intervalo) return `págs. ${intervalo[1]} a ${intervalo[2]}`
  if (/^\s*\d+\s*$/.test(pages)) return `pág. ${pages.trim()}`
  return `págs. ${pages.trim()}`
}

// Roteiros (skills) pelo nome do escritório; desconhecido mantém o nome técnico legível.
const ROTEIROS: Record<string, string> = {
  'gerar-peca-cmr': 'o roteiro de geração de peças do CMR',
  'redacao-cmr': 'o padrão de redação do CMR',
  'revisao-contratual-cmr': 'o roteiro de revisão contratual',
  'leitura-autos': 'o roteiro de leitura dos autos',
  'resposta-notificacao-cmr': 'o roteiro de resposta a notificação',
  docx: 'as ferramentas de documento Word',
  xlsx: 'as ferramentas de planilha',
  pdf: 'as ferramentas de PDF',
  pptx: 'as ferramentas de apresentação',
  'chrome-browser': 'as instruções do navegador',
  'built-in-browser': 'as instruções do navegador',
}

function roteiroConhecido(skill: string): string | null {
  const nome = skill.includes(':') ? skill.slice(skill.lastIndexOf(':') + 1) : skill
  return ROTEIROS[nome] ?? null
}

// "o roteiro" -> "do roteiro"; "as ferramentas" -> "das ferramentas".
function contraiDe(objeto: string): string {
  return objeto.replace(/^(o|a|os|as) /, (_, art: string) => `d${art} `)
}

function leituraDeArquivo(input: unknown): Escrita {
  const p = campo(input, 'file_path') ?? ''
  const base = basename(p)
  const o = obj(input)
  const parte = o.offset !== undefined || o.limit !== undefined ? ' (um trecho)' : ''
  if (/[\\/]tool-results[\\/]/.test(p)) {
    const r = rotuloDoResultadoGrande(base)
    return {
      feito: `Leu o restante de um resultado grande${r ? `: ${r}` : ''}${parte}`,
      rodando: 'Lendo o restante de um resultado grande…',
      categoria: 'leituras',
    }
  }
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(base)) {
    return { feito: `Viu a imagem ${base}`, rodando: `Abrindo a imagem ${base}…`, categoria: 'leituras' }
  }
  if (ehDaMemoria(p)) {
    if (base === 'MEMORY.md') return { feito: 'Leu o índice da memória do caso', rodando: 'Lendo o índice da memória do caso…', categoria: 'leituras' }
    const alvo = ehDoPool(p) ? 'uma orientação do escritório' : 'a anotação da memória'
    return { feito: `Leu ${alvo}: ${nomeDaAnotacao(base)}`, rodando: `Lendo ${alvo}: ${nomeDaAnotacao(base)}…`, categoria: 'leituras' }
  }
  const skill = /[\\/]\.claude[\\/]plugins[\\/].*[\\/]skills[\\/]([^\\/]+)[\\/]/.exec(p)?.[1]
  if (skill) {
    const roteiro = roteiroConhecido(skill) ?? `o roteiro ${nomeDoRoteiro(skill)}`
    return { feito: `Leu o material de apoio ${contraiDe(roteiro)}`, rodando: `Lendo o material de apoio ${contraiDe(roteiro)}…`, categoria: 'leituras' }
  }
  const pages = campo(input, 'pages')
  const pags = pages && /\.pdf$/i.test(base) ? `, ${paginas(pages)}` : ''
  return { feito: `Leu ${objetoDoArquivo(p)}${pags}${parte}`, rodando: `Lendo ${objetoDoArquivo(p)}…`, categoria: 'leituras' }
}

// ---------------------------------------------------------------------------
// Tarefas delegadas pelo tipo do agente e sites oficiais pelo nome.
// ---------------------------------------------------------------------------

const AGENTES: Record<string, [string, string]> = {
  tradutor: ['Pediu uma tradução', 'Pedindo uma tradução'],
  'legal-researcher': ['Pediu uma pesquisa jurídica', 'Pedindo uma pesquisa jurídica'],
  'legal-case-analyst': ['Pediu uma análise dos autos', 'Pedindo uma análise dos autos'],
  'web-fetch': ['Pediu a leitura de páginas da internet', 'Pedindo a leitura de páginas da internet'],
}

// Ordem importa: o mais específico antes (e-SAJ antes do TJSP).
const SITES: ReadonlyArray<[string, string]> = [
  ['planalto.gov.br', 'o site do Planalto (legislação federal)'],
  ['stf.jus.br', 'o site do STF'],
  ['stj.jus.br', 'o site do STJ'],
  ['tst.jus.br', 'o site do TST'],
  ['cnj.jus.br', 'o site do CNJ'],
  ['esaj.tjsp.jus.br', 'o e-SAJ do TJSP'],
  ['tjsp.jus.br', 'o site do TJSP'],
  ['prefeitura.sp.gov.br', 'o site da Prefeitura de São Paulo'],
  ['in.gov.br', 'o Diário Oficial da União'],
  ['jusbrasil.com.br', 'o Jusbrasil'],
  ['conjur.com.br', 'o Conjur'],
]

function hostDe(url: string): string {
  return (url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? url).replace(/^www\./i, '')
}

function siteConhecido(host: string): string | null {
  for (const [dominio, nome] of SITES) if (host === dominio || host.endsWith(`.${dominio}`)) return nome
  return null
}

// ---------------------------------------------------------------------------
// Arquivo entregue ao usuário (SendUserFile): o Claude o produziu na sessão
// em 121 de 123 entregas medidas (09/10/2026), daí "Elaborou".
// ---------------------------------------------------------------------------

function artigoDoArquivo(base: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase() ?? ''
  if (ext === 'docx' || ext === 'doc') return 'o documento'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'a planilha'
  if (ext === 'pdf') return 'o PDF'
  if (ext === 'md' || ext === 'txt') return 'o texto'
  if (/^(png|jpe?g|gif|webp)$/.test(ext)) return 'a imagem'
  if (ext === 'html' || ext === 'htm') return 'a página'
  if (ext === 'pptx') return 'a apresentação'
  return 'o arquivo'
}

function listaComE(itens: string[]): string {
  return itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`
}

function entrega(input: unknown): Omit<Passo, 'fonte'> {
  const arquivos = (Array.isArray(obj(input).files) ? (obj(input).files as unknown[]) : []).filter((f): f is string => typeof f === 'string')
  const nomes = arquivos.map(basename)
  const legenda = campo(input, 'caption')
  const tecnico = [...(legenda ? [legenda] : []), ...arquivos]
  const [unico] = nomes
  if (nomes.length === 1 && unico) {
    const alvo = `${artigoDoArquivo(unico)} ${unico}`
    return { feito: `Elaborou ${alvo}`, rodando: `Enviando ${alvo}…`, tecnico, docx: null, categoria: 'documentos' }
  }
  const alvo = nomes.length ? `${nomes.length} arquivos: ${listaComE(nomes)}` : 'um arquivo'
  return { feito: `Elaborou ${alvo}`, rodando: `Enviando ${nomes.length ? `${nomes.length} arquivos` : 'um arquivo'}…`, tecnico, docx: null, categoria: 'documentos' }
}

// ---------------------------------------------------------------------------
// Navegador (Claude in Chrome e o navegador embutido do Desktop). Cliques e
// digitação trazem `action_summary` escrito pelo modelo: vai como veio, só a
// inicial minúscula ("PJe-Calc" fica intacto). Sem resumo, a frase sai da ação.
// ---------------------------------------------------------------------------

const NAV_PREFIXOS = ['mcp__claude-in-chrome__', 'mcp__Claude_Browser__'] as const
const NAV_FERRAMENTAS = [
  'computer', 'browser_batch', 'navigate', 'find', 'read_page', 'get_page_text', 'javascript_tool', 'form_input',
  'file_upload', 'upload_image', 'tabs_context', 'tabs_context_mcp', 'tabs_create', 'tabs_create_mcp', 'tabs_close',
  'tabs_close_mcp', 'tabs_select', 'resize_window', 'read_console_messages', 'read_network_requests', 'gif_creator',
  'list_connected_browsers', 'select_browser', 'switch_browser', 'shortcuts_execute', 'shortcuts_list',
] as const
const NAVEGADOR: string[] = NAV_PREFIXOS.flatMap(p => NAV_FERRAMENTAS.map(f => `${p}${f}`))

function acaoDoNavegador(tool: string): string | null {
  for (const p of NAV_PREFIXOS) if (tool.startsWith(p)) return tool.slice(p.length)
  return null
}

function minusculaInicial(s: string): string {
  return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

const CLIQUES = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'middle_click'])

function fraseDoComputador(input: unknown): string {
  const resumo = campo(input, 'action_summary')
  if (resumo) return minusculaInicial(resumo.trim())
  const acao = campo(input, 'action') ?? ''
  if (acao === 'screenshot') return 'olhou a tela'
  if (acao === 'wait') return 'esperou a página'
  if (CLIQUES.has(acao)) return 'clicou na página'
  if (acao === 'type') return 'digitou um texto'
  if (acao === 'key') return 'apertou uma tecla'
  if (acao === 'scroll' || acao === 'scroll_to') return 'rolou a página'
  if (acao === 'zoom') return 'ampliou um trecho da tela'
  if (acao === 'hover') return 'passou o mouse sobre a página'
  if (acao === 'left_click_drag') return 'arrastou um elemento'
  return 'agiu na página'
}

function fraseDoEndereco(url: string | null): string {
  if (!url) return 'abriu uma página'
  if (url === 'back') return 'voltou à página anterior'
  if (url === 'forward') return 'avançou uma página'
  if (/^file:/i.test(url)) {
    let caminho = url.replace(/^file:\/*/i, '')
    try {
      caminho = decodeURIComponent(caminho)
    } catch {
      // nome com % solto: fica como veio
    }
    return `abriu o arquivo ${basename(caminho)}`
  }
  return `abriu ${hostDe(url)}`
}

function fraseNoNavegador(acao: string, input: unknown): string {
  switch (acao) {
    case 'computer':
      return fraseDoComputador(input)
    case 'navigate':
      return fraseDoEndereco(campo(input, 'url'))
    case 'find': {
      const q = campo(input, 'query')
      return q ? `procurou «${corta(q, 60)}» na página` : 'procurou na página'
    }
    case 'read_page':
    case 'get_page_text':
      return 'leu o texto da página'
    case 'javascript_tool':
      return 'rodou um script na página'
    case 'form_input':
      return 'preencheu um campo'
    case 'file_upload': {
      const ps = Array.isArray(obj(input).paths) ? (obj(input).paths as unknown[]).filter((x): x is string => typeof x === 'string') : []
      const [um] = ps
      return ps.length === 1 && um ? `anexou o arquivo ${basename(um)}` : ps.length > 1 ? `anexou ${ps.length} arquivos` : 'anexou um arquivo'
    }
    case 'upload_image':
      return 'anexou uma imagem'
    case 'tabs_context':
    case 'tabs_context_mcp':
      return 'conferiu as abas abertas'
    case 'tabs_create':
    case 'tabs_create_mcp':
      return 'abriu uma aba nova'
    case 'tabs_close':
    case 'tabs_close_mcp':
      return 'fechou uma aba'
    case 'tabs_select':
      return 'trocou de aba'
    case 'resize_window':
      return 'ajustou o tamanho da janela'
    case 'read_console_messages':
    case 'read_network_requests':
      return 'leu o registro técnico da página'
    case 'gif_creator':
      return 'gravou a tela'
    case 'shortcuts_execute':
    case 'shortcuts_list':
      return 'usou um atalho do navegador'
    default:
      return 'conectou-se ao navegador'
  }
}

function passoNoNavegador(acao: string, input: unknown): Omit<Passo, 'fonte'> {
  if (acao === 'browser_batch') {
    const acoes = (Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]) : []).map(obj)
    const frases = acoes.map(a => fraseNoNavegador(str(a.name) ?? '', a.input))
    // A ação principal: a que o modelo resumiu; senão a primeira que não é espera nem foto da tela.
    const comResumo = acoes.findIndex(a => campo(a.input, 'action_summary') !== null)
    const principal = comResumo >= 0 ? frases[comResumo] : frases.find(f => f !== 'esperou a página' && f !== 'olhou a tela') ?? frases[0]
    const resumo = frases.length > 1 ? `${frases.length} ações · ${principal ?? ''}` : principal ?? 'agiu na página'
    return { feito: `No navegador: ${resumo}`, rodando: `No navegador: ${resumo}…`, tecnico: frases, docx: null, categoria: 'ações no navegador' }
  }
  const frase = fraseNoNavegador(acao, input)
  return { feito: `No navegador: ${frase}`, rodando: `No navegador: ${frase}…`, tecnico: inputCompacto(input), docx: null, categoria: 'ações no navegador' }
}

// Outras tools do Desktop vistas nas sessões de caso.
const OUTRAS: Record<string, (input: unknown) => Omit<Passo, 'fonte'>> = {
  SendUserFile: entrega,
  Artifact: input => {
    const d = campo(input, 'description')
    const alvo = d ? `: ${corta(d, 120)}` : campo(input, 'file_path') ? ` ${basename(campo(input, 'file_path') ?? '')}` : ''
    return { feito: `Publicou a página${alvo}`, rodando: 'Publicando a página…', tecnico: inputCompacto(input), docx: null, categoria: 'documentos' }
  },
  mcp__ccd_session__mark_chapter: input => {
    const t = campo(input, 'title')
    return { feito: t ? `Marcou um novo capítulo: ${t}` : 'Marcou um novo capítulo', rodando: 'Marcando um novo capítulo…', tecnico: inputCompacto(input), docx: null, categoria: 'outros' }
  },
  mcp__ccd_session_mgmt__list_events: input => ({
    feito: 'Consultou sessões anteriores', rodando: 'Consultando sessões anteriores…', tecnico: inputCompacto(input), docx: null, categoria: 'outros',
  }),
  mcp__ccd_session_mgmt__search_session_transcripts: input => ({
    feito: 'Consultou sessões anteriores', rodando: 'Consultando sessões anteriores…', tecnico: inputCompacto(input), docx: null, categoria: 'outros',
  }),
  TaskStop: input => ({
    feito: 'Interrompeu uma tarefa em segundo plano', rodando: 'Interrompendo uma tarefa em segundo plano…', tecnico: inputCompacto(input), docx: null, categoria: 'outros',
  }),
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
    case 'Bash':
    case 'PowerShell': {
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
      return { ...leituraDeArquivo(input), tecnico: [p], docx: null }
    }
    case 'Write': {
      const p = campo(input, 'file_path') ?? ''
      const conteudo = campo(input, 'content') ?? ''
      const e = ehDaMemoria(p) ? escritaNaMemoria(p, conteudo, false) : escritaDeArquivo(p, false)
      return { ...e, tecnico: [p, `${conteudo.length} caracteres`], docx: null }
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = campo(input, 'file_path') ?? ''
      const velho = campo(input, 'old_string')
      const novo = campo(input, 'new_string')
      const tecnico = [p]
      if (velho) tecnico.push(`- ${corta(velho, 140)}`)
      if (novo) tecnico.push(`+ ${corta(novo, 140)}`)
      const e = ehDaMemoria(p) ? escritaNaMemoria(p, null, true) : escritaDeArquivo(p, true)
      return { ...e, tecnico, docx: null }
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
      const [feito, rodando] = AGENTES[tipo ? tipo.slice(tipo.lastIndexOf(':') + 1) : ''] ?? ['Delegou uma tarefa', 'Delegando uma tarefa']
      return {
        feito: `${feito}: ${descricao}`,
        rodando: `${rodando}: ${descricao}…`,
        tecnico: tipo ? [`agente ${tipo}`] : [],
        docx: null,
        categoria: 'tarefas delegadas',
      }
    }
    case 'Skill': {
      const skill = campo(input, 'skill') ?? ''
      const roteiro = roteiroConhecido(skill)
      return {
        feito: roteiro ? `Abriu ${roteiro}` : `Carregou o roteiro: ${nomeDoRoteiro(skill)}`,
        rodando: roteiro ? `Abrindo ${roteiro}…` : `Carregando o roteiro: ${nomeDoRoteiro(skill)}…`,
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
        discreto: true,
      }
    case 'WebFetch': {
      const url = campo(input, 'url') ?? ''
      const host = hostDe(url)
      const site = siteConhecido(host)
      return {
        feito: site ? `Consultou ${site}` : `Consultou a página: ${corta(host, 60)}`,
        rodando: site ? `Consultando ${site}…` : `Consultando a página: ${corta(host, 60)}…`,
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
      const acao = acaoDoNavegador(tool)
      if (acao !== null) return passoNoNavegador(acao, input)
      const outra = OUTRAS[tool]
      if (outra) return outra(input)
      const juridica = JURIDICAS[tool]
      if (juridica) {
        const f = juridica(input, output)
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
  'anotações',
  'escritas',
  'comandos',
  'buscas em arquivos',
  'pesquisas',
  'tarefas delegadas',
  'roteiros',
  'ações no navegador',
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
  'anotações': 'anotação',
  'ações no navegador': 'ação no navegador',
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

  // Navegador, entregas e tools do Desktop: só a linha. O bloco de resultado
  // fica nativo (print da tela do navegador, cartão do arquivo entregue).
  const SO_LINHA = [...NAVEGADOR, ...Object.keys(OUTRAS)]
  for (const TOOL of [...TOOLS, ...Object.keys(JURIDICAS), ...SO_LINHA]) {
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
            <Text dimColor={passo.discreto === true}>{corta(passo.feito, largura)}</Text>
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

    if (SO_LINHA.includes(TOOL)) continue
    // Bloco do resultado (só existe fora de grupo): o conteúdo técnico vive em "Detalhes".
    on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }

  // Cabeçalho do grupo dobrado, SÓ no terminal (ali a árvore substitui a linha
  // de contagem). No Desktop o cabeçalho nativo é desenhado SEMPRE e a árvore
  // própria entra como linha extra, duplicada (medido 06/10/2026); e reescrever
  // `isExpanded` por botão apaga as linhas. Lá o grupo fica inteiro nativo.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const calls = e.props.calls
    if (e.surface !== 'terminal' || calls.length === 0 || e.props.isExpanded) return next(e)

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
