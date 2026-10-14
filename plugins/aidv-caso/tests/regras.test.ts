import { expect, test } from 'claude-code/testing'
import { docxDaSaida, ehDaMemoria, ehPastaDoCasoDireta, ehRascunho } from '../hooks/regras'

// Mesmos casos que o aidv-passos decide (register.tsx: escritaDeArquivo,
// docxDaSaida). O validate recusa import fora da pasta do plugin, então a regra
// é uma cópia: se ela mudar lá, este teste tem de mudar junto.
test('paridade com o aidv-passos: pasta do caso, rascunho, memória e docx', () => {
  expect(ehPastaDoCasoDireta('/home/pedro/cases/acme/minuta.md')).toBe(true)
  expect(ehPastaDoCasoDireta('C:\\Users\\pedro\\cases\\acme\\minuta.md')).toBe(true)
  expect(ehPastaDoCasoDireta('/home/pedro/cases/.hidden/x.md')).toBe(false)
  expect(ehRascunho('/tmp/claude-1000/x/scratchpad/a.md')).toBe(true)
  expect(ehRascunho('C:\\Users\\pedro\\AppData\\Local\\Temp\\a.md')).toBe(true)
  expect(ehPastaDoCasoDireta('/home/pedro/cases/acme/scratchpad/a.md')).toBe(false)
  expect(ehDaMemoria('/home/pedro/cases/acme/.memoria/pedro/x.md')).toBe(true)
  expect(ehDaMemoria('/home/pedro/cases/acme/MEMORY.md')).toBe(true)
  expect(docxDaSaida({ stdout: 'Salvo: /cases/x/Peca.docx', stderr: '' })).toEqual({ nome: 'Peca.docx', caminho: '/cases/x/Peca.docx', aoLado: false })
  expect(docxDaSaida("[GUARD] versão gravada ao lado como: '/cases/x/Peca (2).docx'")).toEqual({ nome: 'Peca (2).docx', caminho: '/cases/x/Peca (2).docx', aoLado: true })
  expect(docxDaSaida({ stdout: 'ok' })).toBeNull()
})
