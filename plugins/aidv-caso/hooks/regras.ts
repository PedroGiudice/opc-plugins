// Onde o arquivo fica: a pasta do caso circula para os colegas (pool de
// workdocs); o rascunho da sessão é descartado.
//
// CÓPIA das funções de mesmo nome em aidv-passos/hooks/register.tsx
// (escritaDeArquivo, docxDaSaida). O validate do Claude Code recusa import de
// fora da pasta do plugin, então a regra vive duas vezes; o teste
// tests/regras.test.ts trava a paridade. Mudou lá, muda aqui.

export type Docx = { nome: string; caminho: string; aoLado: boolean }

export const OBJETOS_FIXOS = new Set(['CLAUDE.md', 'MAPA_PROCESSUAL.md', 'case.yaml', 'documentos.yaml'])

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function basename(p: string): string {
  const limpo = p.replace(/[\\/]+$/, '')
  const i = Math.max(limpo.lastIndexOf('/'), limpo.lastIndexOf('\\'))
  return i >= 0 ? limpo.slice(i + 1) : limpo
}

export function ehRascunho(p: string): boolean {
  return /[\\/]scratchpad[\\/]/i.test(p) || /appdata[\\/]local[\\/]temp[\\/]/i.test(p)
}

export function ehPastaDoCasoDireta(p: string): boolean {
  return /[\\/]cases[\\/][^\\/.][^\\/]*[\\/]/i.test(p) && !ehRascunho(p)
}

export function ehDaMemoria(p: string): boolean {
  return /[\\/]\.memoria[\\/]/.test(p) || /[\\/]\.feedback[\\/]/.test(p) || basename(p) === 'MEMORY.md'
}

// Texto da saída: Bash resolve `{ stdout, stderr }`; chamada com erro resolve
// o texto que o modelo leu (string). Outras tools: o que der para ler.
export function textoDaSaida(output: unknown): string {
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

export function docxDaSaida(output: unknown): Docx | null {
  const texto = textoDaSaida(output)
  const guard = /gravada ao lado como:\s*'([^']+)'/.exec(texto)?.[1]
  if (guard) return { nome: basename(guard), caminho: guard, aoLado: true }
  const salvo = /^\s*Salvo:\s*(.+?\.docx)\s*$/im.exec(texto)?.[1]
  if (salvo) return { nome: basename(salvo), caminho: salvo, aoLado: false }
  return null
}
