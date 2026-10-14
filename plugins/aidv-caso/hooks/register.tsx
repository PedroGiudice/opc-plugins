import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'
import type { Arquivo, Base, BaseId, Caso, EstadoBase, TipoArquivo } from '../types'
import { OBJETOS_FIXOS, basename, docxDaSaida, ehDaMemoria, ehPastaDoCasoDireta, ehRascunho } from './regras'

// ---------------------------------------------------------------------------
// aidv-caso: painel do caso com três cartões na gramática do trilho direito do
// Claude Desktop (Caso, Bases, Arquivos desta sessão). O que o modelo recebe
// NÃO muda: o mod lê cópias dos resultados em `tool.call` e chama tools por
// `$.mcp.call` (resultado volta ao mod, sem contexto e sem turno).
// Spec: case-docs/docs/superpowers/specs/2026-10-15-aidv-caso-pane-design.md
// ---------------------------------------------------------------------------

const PANE = 'aidv-caso'
const TITULO = 'Caso'
const SERVER_CK = 'plugin_case-knowledge_case-knowledge'
const SERVER_STJ = 'plugin_stj-vec-tools_stj-vec-tools'
const SERVER_LEI = 'plugin_legal-vec-tools_legal-vec-tools'
const MAX_ARQUIVOS = 30
const TIMEOUT_SONDA_MS = 8000

// Paleta AiDV (7 tons do preset claro), a mesma dos outros mods.
const COR_INFO = '#1f4f86'
const COR_LAVENDER = '#5b3fa6'
const COR_OK = '#22603a'
const COR_DANGER = '#a3321f'
const COR_WARN = '#8a4a0b'
const COR_PEACH = '#9a4312'
const COR_NEUTRAL = '#8a857d'

const caso = atom({ plugin: 'aidv-caso', key: 'caso' } as const, null)
const bases = atom({ plugin: 'aidv-caso', key: 'bases' } as const, [])
const arquivos = atom({ plugin: 'aidv-caso', key: 'arquivos' } as const, [])
const instrucaoLogin = atom({ plugin: 'aidv-caso', key: 'instrucaoLogin' } as const, false)

const BASES_INICIAIS: Base[] = (['autos', 'stj', 'lei', 'memoria'] as BaseId[]).map(id => ({ id, estado: 'sem-uso', detalhe: null, quando: null }))

// --- utilitários sem Node (o módulo roda num ambiente próprio) ---

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

function compacta(s: string, max = 160): string {
  const u = s.replace(/\s+/g, ' ').trim()
  return u.length > max ? u.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : u
}

function textoMcp(r: { content: { type: string; text?: string }[] }): string {
  return r.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

// A pasta da sessão é de um caso quando tem `cases/<nome>` no caminho (VM:
// tenants/1/cases/x; máquinas cliente: ~/cases/x ou C:\Users\...\cases\x).
export function ehPastaDeCaso(cwd: string): boolean {
  return /[\\/]cases[\\/][^\\/.][^\\/]*/i.test(cwd)
}

// ---------------------------------------------------------------------------
// Cartão Caso: a ficha (`metadata`), lida pelo mod, sem o modelo.
// ---------------------------------------------------------------------------

// Rótulos do enum de 17 subfamílias: espelho de SUBFAMILIA_LABELS em
// extractor-lab/resources/js/lib/subfamilia.ts (fonte de verdade: CaseSubfamilia).
const SUBFAMILIAS: Record<string, string> = {
  'sf-implementacao': 'Salesforce: implementação/customização com alegação de falha',
  'sf-rescisao': 'Salesforce: rescisão, cobrança, renovação (sem defeito)',
  'sf-mensageria': 'Salesforce: mensageria, excedente, suspensão',
  'sf-notificacao-implementacao': 'Salesforce: notificação recebida alegando falha de implementação',
  'sf-notificacao-rescisao': 'Salesforce: notificação recebida de rescisão/resilição',
  'sf-cobranca-ativa': 'Salesforce: cobrança ativa (outbound, acordo, distrato)',
  trabalhista: 'Trabalhista e RH (empregador)',
  'revisao-contrato': 'Revisão de contrato ou minuta recebida',
  'cobranca-titulo': 'Cobrança com título (execução, monitória)',
  'notificacao-enviar': 'Notificação extrajudicial a enviar',
  inventario: 'Inventário e partilha (arrolamento, prestação de contas do espólio)',
  'registro-imoveis': 'Registro de imóveis (dúvida registral, retificação de área ou matrícula)',
  falencia: 'Falência e recuperação (autos de terceiro, arrematação, alienações)',
  reivindicatoria: 'Reivindicatória e usucapião (querela nullitatis, sobreposição de área)',
  'valores-sem-titulo': 'Disputa de valores sem título',
  'saude-sensivel': 'Plano de saúde e tema sensível',
  societario: 'Societário e cartório',
}

const POLOS: Record<string, string> = { autor: 'autor', reu: 'réu' }

// "2026-10-12T14:03:00Z" -> "12/10/2026". Qualquer outra forma volta como veio.
export function dataCurta(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

// A ficha pode vir com o aviso de corte no topo ("[aviso: ...]\n\n{"): lê o
// JSON a partir da primeira chave. Nunca inventa: campo ausente = null.
export function fichaDe(texto: string): Caso {
  const i = texto.indexOf('{')
  if (i < 0) throw new Error('A ficha não veio em JSON.')
  const o = obj(JSON.parse(texto.slice(i)))
  const natureza = (['judicial', 'nao_judicial', 'indeterminada'] as const).find(n => n === o.natureza) ?? 'indeterminada'
  const briefing = obj(o.briefing)
  return {
    nome: str(o.caso) ?? '?',
    cliente: str(o.cliente),
    polo: str(o.polo),
    natureza,
    tipoAcao: str(briefing.tipo_acao),
    subfamilia: str(o.subfamilia),
    autosAte: str(o.autos_ate),
    carregando: false,
    erro: null,
  }
}

const CASO_VAZIO: Caso = { nome: '…', cliente: null, polo: null, natureza: 'indeterminada', tipoAcao: null, subfamilia: null, autosAte: null, carregando: true, erro: null }

async function carregarFicha($: any): Promise<void> {
  await update($, caso, antes => ({ ...(antes ?? CASO_VAZIO), carregando: true, erro: null }))
  try {
    const r = await $.mcp.call(SERVER_CK, 'metadata', {})
    const texto = textoMcp(r)
    if (r.isError) throw new Error(texto || 'A ficha não respondeu.')
    const nova = fichaDe(texto)
    await update($, caso, () => nova)
    await marcarBase($, 'autos', 'conectada', null)
  } catch (err) {
    const msg = compacta(err instanceof Error ? err.message : String(err), 200).replace(/^Erro ao obter metadata:\s*/i, '')
    await update($, caso, antes => ({ ...(antes ?? CASO_VAZIO), carregando: false, erro: msg }))
    await marcarBase($, 'autos', estadoDoErro(msg), msg)
  }
}

// ---------------------------------------------------------------------------
// Cartão Bases (completado na task 5).
// ---------------------------------------------------------------------------

// Rede: a mensagem do refresh do plugin ("Sem conexão com …") e as falhas
// cruas do fetch com token válido (fetch failed, DNS, timeout, abort), que são
// o cenário do incidente de 08/10/2026. Login: só o que o plugin diz ser login.
export function estadoDoErro(texto: string): EstadoBase {
  if (/sem conexão com|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|aborted|AbortError|network/i.test(texto)) return 'rede'
  if (/expirou|não autorizado \(401\)|sem credencial/i.test(texto)) return 'login'
  return 'erro'
}

async function marcarBase($: any, id: BaseId, estado: EstadoBase, detalhe: string | null): Promise<void> {
  const quando = await $.clock.now()
  await update($, bases, lista => (lista.length ? lista : BASES_INICIAIS).map(b => (b.id === id ? { id, estado, detalhe, quando } : b)))
}

const NOME_BASE: Record<BaseId, string> = { autos: 'Autos', stj: 'STJ', lei: 'Legislação', memoria: 'Memória' }
const GLIFO_BASE: Record<BaseId, [string, string]> = { autos: ['■', COR_INFO], stj: ['◈', COR_LAVENDER], lei: ['§', COR_OK], memoria: ['●', COR_PEACH] }
// O mod não abre o menu do AiDV: a instrução é a ação. O comando é a forma que
// o próprio plugin mostra sem CLAUDE_PLUGIN_ROOT (o mod não sabe o caminho).
const INSTRUCAO_LOGIN = "No AiDV, abra o menu AiDV (ou o ícone na bandeja) e escolha 'Entrar de novo na conta…'. Sem o AiDV, rode o comando abaixo num terminal."
const COMANDO_LOGIN = 'node <plugin>/server.mjs login'

function ha(quando: number | null, agora: number): string {
  if (quando === null) return ''
  const min = Math.floor((agora - quando) / 60000)
  return min < 1 ? ' · agora' : min < 60 ? ` · há ${min} min` : ` · há ${Math.floor(min / 60)} h`
}

async function registrarSinal($: any, id: BaseId, r: Record<string, unknown>): Promise<void> {
  const texto = typeof r.text === 'string' ? r.text : ''
  if (r.isError) {
    const msg = compacta(texto, 200)
    await marcarBase($, id, msg ? estadoDoErro(msg) : 'erro', msg || 'sem mensagem')
  } else {
    await marcarBase($, id, 'conectada', null)
  }
}

// Sonda as três bases com uma tool barata, sem o modelo. Memória fica de fora:
// a única tool dela exige query e embedding.
async function sondar($: any): Promise<void> {
  const alvos: { id: BaseId; server: string; tool: string }[] = [
    // `info` é local (não chama a API): só `list_cases` prova a conexão.
    { id: 'autos', server: SERVER_CK, tool: 'list_cases' },
    { id: 'stj', server: SERVER_STJ, tool: 'filters' },
    { id: 'lei', server: SERVER_LEI, tool: 'sources' },
  ]
  await Promise.all(alvos.map(async a => {
    const timeout = $.clock.sleep(TIMEOUT_SONDA_MS).then(() => 'timeout' as const)
    try {
      const r = await Promise.race([$.mcp.call(a.server, a.tool, {}), timeout])
      if (r === 'timeout') {
        await marcarBase($, a.id, 'rede', 'sem resposta em 8 s')
        return
      }
      await registrarSinal($, a.id, { isError: r.isError, text: textoMcp(r) })
    } catch (err) {
      const msg = compacta(err instanceof Error ? err.message : String(err), 200)
      await marcarBase($, a.id, estadoDoErro(msg), msg || 'sem mensagem')
    }
  }))
}

// ---------------------------------------------------------------------------
// Cartão Arquivos desta sessão: o que o Claude gravou na pasta do caso.
// ---------------------------------------------------------------------------

const ROTULO_TIPO: Record<TipoArquivo, [string, string, string]> = {
  docx: ['■', COR_INFO, 'documento montado'],
  memoria: ['›', COR_LAVENDER, 'anotação na memória'],
  briefing: ['›', COR_PEACH, 'briefing do caso'],
  outro: ['›', COR_PEACH, 'arquivo'],
}
const ROTULO_FIXO: Record<string, string> = {
  'CLAUDE.md': 'briefing do caso',
  'MAPA_PROCESSUAL.md': 'mapa processual',
  'case.yaml': 'ficha do caso',
  'documentos.yaml': 'inventário de documentos',
}

function horaCurta(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Só o que circula pelo pool: pasta do caso, fora de rascunho.
export function classificarEscrita(p: string): TipoArquivo | null {
  if (ehRascunho(p)) return null
  if (ehDaMemoria(p)) return /[\\/]cases[\\/]/i.test(p) ? 'memoria' : null
  if (!ehPastaDoCasoDireta(p)) return null
  if (OBJETOS_FIXOS.has(basename(p))) return 'briefing'
  return /\.docx$/i.test(p) ? 'docx' : 'outro'
}

async function registrarArquivo($: any, caminho: string, verbo: string, tipo: TipoArquivo): Promise<void> {
  const quando = await $.clock.now()
  await update($, arquivos, lista => {
    const existente = lista.find(a => a.caminho === caminho)
    const item: Arquivo = existente
      ? { ...existente, verbo: 'alterado', vezes: existente.vezes + 1, quando }
      : { caminho, nome: basename(caminho), tipo, verbo, vezes: 1, quando }
    return [...lista.filter(a => a.caminho !== caminho), item].slice(-MAX_ARQUIVOS)
  })
}

// O gerador imprime "Salvo: <caminho como foi passado>" (às vezes relativo) e
// o guard só o NOME do desvio: resolve contra a pasta da sessão.
export function absoluto(caminho: string, cwd: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(caminho)) return caminho
  const sep = /\\/.test(cwd) ? '\\' : '/'
  return cwd.replace(/[\\/]+$/, '') + sep + caminho
}

// Abre no programa padrão da máquina da pessoa (em sessão local do Desktop o
// motor roda nela). O opener vem da forma do caminho, não de um `platform`.
// No Windows, explorer.exe e não `cmd /c start`: o cmd interpreta & ^ % de um
// nome de arquivo (e um nome forjado nos autos viraria comando).
export function opener(caminho: string): string[] {
  if (/^[A-Za-z]:[\\/]/.test(caminho)) return ['explorer.exe', caminho]
  if (/^\/Users\//.test(caminho)) return ['open', caminho]
  return ['xdg-open', caminho]
}

function verboDe(a: Arquivo): string {
  const rotulo = a.tipo === 'briefing' ? ROTULO_FIXO[a.nome] ?? ROTULO_TIPO.briefing[2] : ROTULO_TIPO[a.tipo][2]
  const vezes = a.vezes > 1 ? ` ${a.vezes}x` : ''
  return `${rotulo} · ${a.nome} · ${a.verbo}${vezes} · ${horaCurta(a.quando)}`
}

// `focus` só pode ser true ou ausente (o host recusa `false`).
async function abrirPainel($: any, focus: boolean): Promise<void> {
  const r = await $.ui.open(focus ? { id: PANE, title: TITULO, columns: 56, focus: true } : { id: PANE, title: TITULO, columns: 56 })
  if (!r.isPlaced && focus) $.ui.toast('Alargue a janela para ver o painel do caso.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'caso', description: 'Abre o painel do caso (ficha, bases e arquivos desta sessão).' })
    const atual = await read($, bases)
    if (atual.length === 0) await update($, bases, () => BASES_INICIAIS)
    if (ehPastaDeCaso(e.cwd)) {
      const ja = await read($, caso)
      if (ja === null) {
        // Sem await: a sessão não espera a ficha nem a sondagem para começar.
        // O catch engole a recusa do host quando o módulo é descarregado no meio
        // (reload ou fim de sessão): nada a fazer nesse caso.
        void carregarFicha($).then(() => sondar($)).catch(() => undefined)
      }
      void abrirPainel($, false)
    }
    return next(e)
  })

  on('command.run', { command: 'caso' }, async $ => {
    const cwd = await $.session.cwd()
    if (!ehPastaDeCaso(cwd)) return { text: 'Esta sessão não está numa pasta de caso.' }
    const ja = await read($, caso)
    if (ja === null) void carregarFicha($).then(() => sondar($)).catch(() => undefined)
    await abrirPainel($, true)
    return { text: 'Painel do caso aberto.' }
  })

  // Cada chamada das quatro bases é um sinal de estado (só laço principal).
  // Qual base cada tool sinaliza (regex literal: o validate lê o matcher). A
  // memória (legal-cogmem) é alcançada pela `memoria_search` do mesmo server
  // do case-knowledge; o resto dele é Autos.
  on('tool.call', { tool: /^mcp__plugin_case-knowledge_case-knowledge__memoria_search$/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    await registrarSinal($, 'memoria', r as Record<string, unknown>)
    return r
  })
  on('tool.call', { tool: /^mcp__plugin_case-knowledge_case-knowledge__(?!memoria_search$|info$)/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    await registrarSinal($, 'autos', r as Record<string, unknown>)
    return r
  })
  on('tool.call', { tool: /^mcp__plugin_stj-vec-tools_stj-vec-tools__/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    await registrarSinal($, 'stj', r as Record<string, unknown>)
    return r
  })
  on('tool.call', { tool: /^mcp__plugin_legal-vec-tools_legal-vec-tools__/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    await registrarSinal($, 'lei', r as Record<string, unknown>)
    return r
  })

  // Escritas na pasta do caso (só laço principal; escrita com erro não entra).
  // (regex: MultiEdit não consta na união de nomes deste build.)
  on('tool.call', { tool: /^(Write|Edit|MultiEdit)$/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    const bruto = str((e as Record<string, unknown>).file_path)
    if (bruto && !('isError' in r && r.isError)) {
      const p = absoluto(bruto, await $.session.cwd())
      const tipo = classificarEscrita(p)
      if (tipo) await registrarArquivo($, p, String(e.tool) === 'Write' ? 'salvo' : 'alterado', tipo)
    }
    return r
  })

  // `.docx` dos geradores CMR: o stdout diz "Salvo: <caminho>.docx" (ou o guard).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    if ('isError' in r && r.isError) return r
    const saida = 'result' in r ? r.result : 'text' in r ? r.text : null
    const docx = docxDaSaida(saida)
    if (docx) {
      const p = absoluto(docx.caminho, await $.session.cwd())
      if (classificarEscrita(p) !== null) await registrarArquivo($, p, docx.aoLado ? 'gravado ao lado' : 'montado', 'docx')
    }
    return r
  })

  // Painel: três cartões.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, caso)

    // Pede o foco de volta ao painel: no Desktop, cada redesenho solta o
    // teclado e o clique seguinte viraria foco em vez de pressão.
    const refocar = () => {
      $.clock.after(250, () => {
        void $.ui.open({ id: PANE, title: TITULO, focus: true })
      })
    }

    // --- Caso ---
    const linhasCaso: RenderElement[] = []
    if (c === null) {
      linhasCaso.push(<Text key="c-vazio" dimColor>Sem ficha nesta sessão.</Text>)
    } else if (c.carregando && c.nome === '…') {
      linhasCaso.push(<Text key="c-lendo" dimColor>Lendo a ficha do caso…</Text>)
    } else if (c.erro && c.nome === '…') {
      // Nunca houve ficha: nada a afirmar sobre cliente ou natureza.
      linhasCaso.push(<Text key="c-erro" color={COR_DANGER} wrap="wrap">Não li a ficha do caso: {c.erro}</Text>)
    } else {
      linhasCaso.push(<Text key="c-nome" bold>{c.nome}</Text>)
      if (c.erro) linhasCaso.push(<Text key="c-erro" color={COR_DANGER} wrap="wrap">Não li a ficha do caso: {c.erro}</Text>)
      const cliente = c.cliente ?? 'cliente não informado'
      const polo = c.natureza === 'judicial' && c.polo ? ` · ${POLOS[c.polo] ?? c.polo}` : ''
      linhasCaso.push(<Text key="c-cliente">{cliente}{polo}</Text>)
      const natureza =
        c.natureza === 'judicial' ? `Processo${c.tipoAcao ? ` · ${c.tipoAcao}` : ''}`
        : c.natureza === 'nao_judicial' ? `Consultivo${c.subfamilia ? ` · ${SUBFAMILIAS[c.subfamilia] ?? c.subfamilia}` : ''}`
        : 'Natureza não definida'
      linhasCaso.push(<Text key="c-natureza" dimColor wrap="wrap">{natureza}</Text>)
      if (c.natureza === 'judicial') {
        linhasCaso.push(
          c.autosAte
            ? <Text key="c-autos">Autos até {dataCurta(c.autosAte)}</Text>
            : <Text key="c-autos" color={COR_WARN}>Sem autos na base</Text>,
        )
      }
    }
    linhasCaso.push(
      <Box key="c-acoes" columnGap={2}>
        <Button key="atualizar" plain dimColor onPress={async () => { await carregarFicha($); refocar() }}>Atualizar</Button>
      </Box>,
    )

    // --- Bases ---
    const listaBases = await read($, bases)
    const mostrarLogin = await read($, instrucaoLogin)
    const agora = await $.clock.now()
    const linhasBases: RenderElement[] = (listaBases.length ? listaBases : BASES_INICIAIS).map(b => {
      const [glifo, cor] = GLIFO_BASE[b.id]
      const [estado, corEstado]: [string, string | undefined] =
        b.estado === 'conectada' ? ['conectada', COR_OK]
        : b.estado === 'rede' ? ['sem conexão com o escritório', COR_WARN]
        : b.estado === 'login' ? ['entre de novo na conta', COR_DANGER]
        : b.estado === 'erro' ? [`falhou: ${b.detalhe ?? 'sem mensagem'}`, COR_DANGER]
        : ['ainda não usada nesta sessão', undefined]
      return (
        <Box key={`b-${b.id}`} columnGap={1}>
          <Text color={cor}>{glifo}</Text>
          <Text>{NOME_BASE[b.id]} ·</Text>
          <Text color={corEstado} dimColor={corEstado === undefined} wrap="truncate-end">{estado}{ha(b.quando, agora)}</Text>
        </Box>
      )
    })
    const algumLogin = listaBases.some(b => b.estado === 'login')
    const acoesBases: RenderElement[] = [
      <Button key="verificar" plain dimColor onPress={async () => { await sondar($); refocar() }}>Verificar agora</Button>,
    ]
    if (algumLogin) {
      acoesBases.push(
        <Button key="como-entrar" plain dimColor onPress={async () => { await update($, instrucaoLogin, v => !v); refocar() }}>Como entrar de novo</Button>,
      )
    }
    linhasBases.push(<Box key="b-acoes" columnGap={2}>{acoesBases}</Box>)
    if (algumLogin && mostrarLogin) {
      linhasBases.push(
        <Box key="b-instrucao" flexDirection="column" paddingLeft={2}>
          <Text wrap="wrap">{INSTRUCAO_LOGIN}</Text>
          <Box columnGap={1}>
            <Text dimColor>{COMANDO_LOGIN}</Text>
            <Button key="copiar-login" plain dimColor onPress={async press => { await $.ui.copy({ text: COMANDO_LOGIN, surface: press.surface }); refocar() }}>Copiar comando</Button>
          </Box>
        </Box>,
      )
    }

    // --- Arquivos desta sessão ---
    const lista = await read($, arquivos)
    const linhasArquivos: RenderElement[] = lista.length === 0
      ? [<Text key="a-vazio" dimColor>Nada gravado na pasta do caso ainda.</Text>]
      : [...lista].reverse().map((a, i) => {
          const [glifo, cor] = ROTULO_TIPO[a.tipo]
          return (
            <Box key={`a-${i}`} columnGap={1}>
              <Text color={cor}>{glifo}</Text>
              <Text wrap="truncate-end">{verboDe(a)}</Text>
              <Button key={`abrir-${i}`} plain dimColor onPress={async press => {
                try {
                  const r = await $.process.run(opener(a.caminho))
                  if (r.exitCode !== 0) throw new Error(r.stderr || `saiu com ${r.exitCode}`)
                } catch {
                  // Numa superfície remota a cópia pode não ter caminho: o toast traz o caminho.
                  const c = await $.ui.copy({ text: a.caminho, surface: press.surface })
                  $.ui.toast(c.isCopied ? 'Não consegui abrir o arquivo; caminho copiado.' : `Não consegui abrir o arquivo: ${a.caminho}`)
                } finally {
                  refocar()
                }
              }}>Abrir</Button>
            </Box>
          )
        })

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Caso</Text>
        <Box flexDirection="column" paddingLeft={1}>{linhasCaso}</Box>
        <Box height={1} />
        <Text bold>Bases</Text>
        <Box flexDirection="column" paddingLeft={1}>{linhasBases}</Box>
        <Box height={1} />
        <Text bold>Arquivos desta sessão</Text>
        <Box flexDirection="column" paddingLeft={1}>{linhasArquivos}</Box>
        <Box marginTop={1}>
          <Button key="fechar" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })}>Fechar</Button>
        </Box>
      </Box>
    )
  })
}
