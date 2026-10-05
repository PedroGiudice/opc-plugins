import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Categoria, Juridico, Medida } from '../types'

const medida = atom({ plugin: 'aidv-contexto', key: 'medida' } as const, null)
const juridico = atom({ plugin: 'aidv-contexto', key: 'juridico' } as const, { autos: 0, jurisprudencia: 0, legislacao: 0 })

const COR = {
  instrucoes: '#6B7280',
  ferramentas: '#0E7490',
  memoria: '#A855F7',
  autos: '#2563EB',
  jurisprudencia: '#D97706',
  legislacao: '#059669',
  conversa: '#94A3B8',
  outros: '#9CA3AF',
}

// Rótulos em português para as categorias que o motor nomeia em inglês.
const ROTULOS: [RegExp, string, string][] = [
  [/system prompt/i, 'Instruções', COR.instrucoes],
  [/memory/i, 'Memória do caso', COR.memoria],
  [/tool|agent|skill|command/i, 'Ferramentas', COR.ferramentas],
]

// Tools jurídicas (MCP) cujos resultados entram na conversa como leitura.
const FONTES: [RegExp, keyof Juridico][] = [
  [/^mcp__plugin_case-knowledge/, 'autos'],
  [/^mcp__plugin_stj-vec-tools/, 'jurisprudencia'],
  [/^mcp__plugin_legal-vec-tools/, 'legislacao'],
]

function agrupa(cats: { name: string; tokens: number; kind: string }[], j: Juridico): Categoria[] {
  const soma = new Map<string, Categoria>()
  const add = (rotulo: string, tokens: number, cor: string) => {
    if (tokens <= 0) return
    const atual = soma.get(rotulo) ?? { rotulo, tokens: 0, cor }
    atual.tokens += tokens
    soma.set(rotulo, atual)
  }
  for (const c of cats) {
    if (c.kind !== 'used') continue
    if (/messages/i.test(c.name)) {
      // A categoria "Messages" do motor junta conversa e resultados de tools;
      // separamos pelo que medimos nas chamadas das tools jurídicas.
      const lidas = j.autos + j.jurisprudencia + j.legislacao
      const fator = lidas > c.tokens ? c.tokens / lidas : 1
      add('Autos do caso', Math.round(j.autos * fator), COR.autos)
      add('Jurisprudência', Math.round(j.jurisprudencia * fator), COR.jurisprudencia)
      add('Legislação', Math.round(j.legislacao * fator), COR.legislacao)
      add('Conversa', Math.max(0, c.tokens - Math.round(lidas * fator)), COR.conversa)
      continue
    }
    const hit = ROTULOS.find(([re]) => re.test(c.name))
    if (hit) add(hit[1], c.tokens, hit[2])
    else add(c.name, c.tokens, COR.outros)
  }
  return [...soma.values()]
}

type Faixa = { cor: string; titulo: string | null; conselho: string | null }

function faixa(p: number): Faixa {
  if (p < 75) return { cor: '#15803D', titulo: null, conselho: null }
  if (p < 90) return { cor: '#B45309', titulo: 'Contexto cheio', conselho: 'Conclua esta tarefa aqui. A próxima tarefa ou outro caso merece uma sessão nova.' }
  return { cor: '#B91C1C', titulo: 'Quase no limite', conselho: 'O Claude vai resumir a conversa em breve. Salve o que importa em arquivo antes.' }
}

function mil(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    const texto = Number.isInteger(m) ? String(m) : m.toFixed(1).replace('.', ',')
    return `${texto} ${m > 1 ? 'milhões' : 'milhão'}`
  }
  return n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n)
}

function renovaEm(iso: string | undefined, agora: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - agora
  if (!(ms > 0)) return 'renova agora'
  const min = Math.round(ms / 60000)
  if (min < 60) return `renova em ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `renova em ${h} h ${min % 60} min`
  const d = Math.floor(h / 24)
  return `renova em ${d} d ${h % 24} h`
}

function corLimite(p: number): string {
  return p >= 90 ? '#B91C1C' : p >= 70 ? '#B45309' : '#15803D'
}

// Estimativa local: o motor não expõe contagem de tokens por resultado de tool.
function tokensDe(texto: string): number {
  return Math.round(texto.length / 4)
}

export const register: Register = on => {
  // Mede o que cada tool jurídica trouxe para a conversa (só o laço principal:
  // o que um subagente lê não entra neste contexto).
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const fonte = FONTES.find(([re]) => re.test(e.tool))
    if (fonte && 'text' in r && typeof r.text === 'string') {
      const n = tokensDe(r.text)
      await update($, juridico, j => ({ ...j, [fonte[1]]: j[fonte[1]] + n }))
    }
    return r
  })

  // Após compactar, os resultados antigos viram resumo: zera a medição.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await update($, juridico, () => ({ autos: 0, jurisprudencia: 0, legislacao: 0 }))
    return r
  })

  // O motor empurra as medidas após cada turno; guardamos sem o breakdown.
  on('session.measure', async ($, e, next) => {
    await update($, medida, antes => ({
      percent: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      categorias: antes?.categorias ?? [],
      limites: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    }))
    return next(e)
  })

  // O breakdown por categoria é estimado localmente ("summary"): sem chamada à API.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage({ breakdown: 'summary' })
    const j = await read($, juridico)
    const categorias = u.context.breakdown ? agrupa(u.context.breakdown.categories, j) : []
    await update($, medida, antes => ({
      percent: u.context.percent ?? antes?.percent ?? null,
      tokens: u.context.tokens ?? antes?.tokens ?? null,
      window: u.context.window,
      categorias: categorias.length ? categorias : antes?.categorias ?? [],
      limites: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const m: Medida | null = await read($, medida)
    const { Box, Text } = $.ui.resolve(e)

    if (m === null || m.percent === null || m.tokens === null) {
      const pasta0 = (await $.session.cwd()).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      return (
        <Box columnGap={2}>
          <Text bold>{pasta0}</Text>
          <Text dimColor>Contexto da sessão: a contagem começa na primeira resposta.</Text>
        </Box>
      )
    }

    const p = m.percent
    const f = faixa(p)
    const largura = Math.max(20, Math.min(50, Math.floor(e.props.bodyColumns * 0.4)))
    const agora = await $.clock.now()
    const pasta = (await $.session.cwd()).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

    const segmentos = m.categorias.map(c => ({ ...c, celulas: Math.round((c.tokens / m.window) * largura) }))
    const usadas = segmentos.reduce((s, c) => s + c.celulas, 0)
    const livres = Math.max(0, largura - usadas)

    const cincoHoras = m.limites.find(l => l.kind === 'five_hour')
    const semana = m.limites.find(l => l.kind === 'seven_day')

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{pasta}</Text>
          <Text dimColor>  </Text>
          {segmentos.map((s, i) => (
            <Text key={`seg-${i}`} color={s.cor} hover={{ scope: `cat-${s.rotulo}`, inverse: true }}>
              {'█'.repeat(s.celulas)}
            </Text>
          ))}
          <Text dimColor>{'░'.repeat(livres)}</Text>
          <Text> </Text>
          <Text bold color={f.cor}>{p}%</Text>
          {f.titulo ? <Text bold> {f.titulo}</Text> : null}
          <Text dimColor> · {mil(m.tokens)} de {mil(m.window)} tokens</Text>
        </Box>
        {segmentos.length > 0 ? (
          <Box columnGap={2}>
            {segmentos.map((s, i) => (
              <Box key={`leg-${i}`} columnGap={1}>
                <Text color={s.cor} hover={{ scope: `cat-${s.rotulo}`, inverse: true }}>■</Text>
                <Text dimColor hover={{ scope: `cat-${s.rotulo}`, dimColor: false }}>{s.rotulo} {mil(s.tokens)}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {f.conselho ? <Text color={f.cor}>{f.conselho}</Text> : null}
        {cincoHoras || semana ? (
          <Box columnGap={3}>
            {cincoHoras ? (
              <Box columnGap={1}>
                <Text dimColor>Uso nas 5 h</Text>
                <Text bold color={corLimite(cincoHoras.percentUsed)}>{Math.round(cincoHoras.percentUsed)}%</Text>
                <Text dimColor>{renovaEm(cincoHoras.resetsAt, agora)}</Text>
              </Box>
            ) : null}
            {semana ? (
              <Box columnGap={1}>
                <Text dimColor>Uso na semana</Text>
                <Text bold color={corLimite(semana.percentUsed)}>{Math.round(semana.percentUsed)}%</Text>
                <Text dimColor>{renovaEm(semana.resetsAt, agora)}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
