import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pararExtracoesManuais, tokens, recall, resolverCaminho, montarRelatorio } from "./benchmark-extracao.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "benchmark-extracao.mjs");

const uso = (id, command, name = "Bash") =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command, description: "x" } }] } });
const res = (id, content, extra = {}) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });

const linhas = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'python -c "import docx; print(docx.Document(r\'C:\\\\Users\\\\pedro\\\\cases\\\\caso-x\\\\Contrato v3.docx\'))"', description: "Extrair o texto do contrato" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "CLÁUSULA PRIMEIRA - DO OBJETO\nO presente contrato..." }] }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls ~/cases/caso-x", description: "Listar" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "a.pdf" }] } }),
];

test("pararExtracoesManuais: casa tool_use com .docx no comando ao seu tool_result", () => {
  const pares = pararExtracoesManuais(linhas);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].arquivo, "C:\\Users\\pedro\\cases\\caso-x\\Contrato v3.docx");
  assert.ok(pares[0].resultado.startsWith("CLÁUSULA PRIMEIRA"));
});

test("tokens e recall: normaliza caixa e acentos NFC, ignora tokens de 1 caractere", () => {
  const manual = "CLÁUSULA Primeira - do objeto: 10 dias";
  assert.deepEqual([...tokens(manual)].sort(), ["10", "cláusula", "dias", "do", "objeto", "primeira"]);
  const r = recall(manual, "1. Cláusula Primeira do objeto em 10 dias");
  assert.equal(r.recall, 1);
  const r2 = recall(manual, "Cláusula Primeira");
  assert.equal(r2.recall, 2 / 6);
  assert.deepEqual(r2.faltantes.sort(), ["10", "dias", "do", "objeto"]);
});

test("tokens: NFD no texto manual casa com NFC no sidecar", () => {
  const nfd = "cla\u0301usula";
  assert.equal(recall(nfd, "cláusula").recall, 1);
});

test("recall: manual sem tokens vale 1", () => {
  assert.deepEqual(recall("- . ,", "qualquer"), { recall: 1, faltantes: [] });
});

test("pararExtracoesManuais: PowerShell com caminho POSIX-no-Windows (.msg), mantido como achado", () => {
  const pares = pararExtracoesManuais([
    uso("p1", "python -c \"import extract_msg; print(extract_msg.Message('/c/Users/pedro/cases/x/y.msg').body)\"", "PowerShell"),
    res("p1", "Prezados, segue o contrato."),
  ]);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].arquivo, "/c/Users/pedro/cases/x/y.msg");
  assert.equal(pares[0].resultado, "Prezados, segue o contrato.");
});

test("pararExtracoesManuais: tool_result com content string simples", () => {
  const pares = pararExtracoesManuais([uso("s1", "cat 'C:\\Users\\pedro\\cases\\a\\planilha.xlsx'"), res("s1", "linha 1\nlinha 2")]);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].resultado, "linha 1\nlinha 2");
});

test("pararExtracoesManuais: ~/cases e barras duplas (\\\\) normalizadas", () => {
  const pares = pararExtracoesManuais([
    uso("a", "python x.py ~/cases/caso/Email.eml"),
    res("a", "ok"),
    uso("b", 'python -c "open(\'C:\\\\Users\\\\pedro\\\\cases\\\\caso\\\\Peticao.DOCM\')"'),
    res("b", "ok2"),
  ]);
  assert.deepEqual(pares.map((p) => p.arquivo), ["~/cases/caso/Email.eml", "C:\\Users\\pedro\\cases\\caso\\Peticao.DOCM"]);
});

test("pararExtracoesManuais: resultado numa linha posterior, intercalado com outros usos", () => {
  const pares = pararExtracoesManuais([
    uso("u1", "type C:\\Users\\pedro\\cases\\c\\a.docx"),
    uso("u2", "type C:\\Users\\pedro\\cases\\c\\b.xlsx"),
    "",
    "linha que nao e json",
    res("u2", "texto b"),
    res("u1", "texto a"),
  ]);
  assert.deepEqual(pares.map((p) => [p.arquivo.slice(-6), p.resultado]), [["b.xlsx", "texto b"], ["a.docx", "texto a"]]);
});

test("pararExtracoesManuais: ignora ferramenta que não é Bash/PowerShell, comando sem arquivo, id sem resultado e resultado de erro", () => {
  const pares = pararExtracoesManuais([
    uso("r1", "C:\\Users\\pedro\\cases\\c\\a.docx", "Read"),
    res("r1", "x"),
    uso("e1", "type C:\\Users\\pedro\\cases\\c\\a.docx"),
    res("e1", "Traceback (most recent call last)", { is_error: true }),
    uso("o1", "type C:\\Users\\pedro\\fora\\a.docx"),
    res("o1", "x"),
    uso("n1", "type C:\\Users\\pedro\\cases\\c\\sem-resultado.docx"),
    res("outro-id", "x"),
  ]);
  assert.deepEqual(pares, []);
});

test("pararExtracoesManuais: sidecar .docx.md e separadores de comando não entram no caminho", () => {
  const pares = pararExtracoesManuais([
    uso("m1", "cat C:\\Users\\pedro\\cases\\c\\a.docx.md"),
    res("m1", "x"),
    uso("m2", "cd C:\\Users\\pedro\\cases\\c; python ler.py b.xlsx"),
    res("m2", "x"),
  ]);
  assert.deepEqual(pares, []);
});

test("resolverCaminho: como está, /c/ -> C:\\, ~ -> home e relativo à pasta de casos", () => {
  const doCasos = join("D:\\casos", "z", "w.docx");
  const existentes = new Set(["C:\\Users\\pedro\\cases\\x\\y.msg", doCasos, "/tmp/direto.docx"]);
  const existe = (p) => existentes.has(p);
  const opts = { home: "C:\\Users\\pedro", cases: "D:\\casos", existe };
  assert.equal(resolverCaminho("/tmp/direto.docx", opts), "/tmp/direto.docx");
  assert.equal(resolverCaminho("/c/Users/pedro/cases/x/y.msg", opts), "C:\\Users\\pedro\\cases\\x\\y.msg");
  assert.equal(resolverCaminho("~/cases/x/y.msg", opts), "C:\\Users\\pedro\\cases\\x\\y.msg");
  assert.equal(resolverCaminho("/outra/maquina/cases/z/w.docx", opts), doCasos);
  assert.equal(resolverCaminho("/c/Users/pedro/cases/nao/existe.docx", opts), null);
});

test("montarRelatorio: tabela com Bytes e ms, linha de resumo com o maior ms", () => {
  const md = montarRelatorio({
    linhas: [
      { arquivo: "C:\\a|b.docx", bytes: 1000, ms: 12.4, recall: 1, tokensManuais: 10, faltantes: [] },
      { arquivo: "C:\\c.xlsx", bytes: 2048, ms: 340.6, recall: 0.5, tokensManuais: 4, faltantes: ["aa", "bb"] },
      { arquivo: "C:\\d.eml", bytes: 5, ms: 1, erro: "falhou\nfeio" },
    ],
    ausentes: 2,
  });
  assert.match(md, /\| Arquivo \| Bytes \| ms \| Recall \| Tokens manuais \| Faltantes \(amostra\) \|/);
  assert.match(md, /\| C:\\a\\\|b\.docx \| 1000 \| 12 \| 100\.0% \| 10 \|  \|/);
  assert.match(md, /\| C:\\c\.xlsx \| 2048 \| 341 \| 50\.0% \| 4 \| aa, bb \|/);
  assert.match(md, /\| C:\\d\.eml \| 5 \| 1 \| ERRO \| \| falhou feio \|/);
  assert.match(md, /Arquivos comparados: 3; abaixo de 99%: 2; citados no JSONL mas ausentes no disco: 2; maior tempo de extração: 341 ms \(C:\\c\.xlsx\)\./);
});

test("montarRelatorio: sem arquivos comparados", () => {
  const md = montarRelatorio({ linhas: [], ausentes: 1 });
  assert.match(md, /Arquivos comparados: 0; abaixo de 99%: 0; citados no JSONL mas ausentes no disco: 1; maior tempo de extração: n\/d\./);
});

test("CLI: compara JSONL com o arquivo em disco, grava só o relatório e nenhum sidecar", () => {
  const raiz = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    const cases = join(raiz, "cases");
    mkdirSync(join(cases, "caso-x"), { recursive: true });
    const eml = join(cases, "caso-x", "msg.eml");
    writeFileSync(eml, "From: Ana <ana@x.com>\r\nTo: bob@x.com\r\nSubject: Contrato\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSegue a minuta do contrato revisada.\r\n");
    const projects = join(raiz, "projects", "p1");
    mkdirSync(projects, { recursive: true });
    const jsonl = [
      uso("c1", `python ler.py ${eml}`),
      res("c1", "Segue a minuta do contrato revisada."),
      uso("c2", "python ler.py /c/Users/pedro/cases/caso-x/sumiu.msg", "PowerShell"),
      res("c2", "x"),
    ].join("\n");
    writeFileSync(join(projects, "s.jsonl"), jsonl);
    const antes = readdirSync(join(cases, "caso-x")).sort();
    const saida = join(raiz, "rel.md");
    execFileSync(process.execPath, [SCRIPT, "--projects", join(raiz, "projects"), "--cases", cases, "--saida", saida], { encoding: "utf-8" });
    assert.deepEqual(readdirSync(join(cases, "caso-x")).sort(), antes);
    const md = readFileSync(saida, "utf-8");
    assert.match(md, /\| 100\.0% \|/);
    assert.match(md, /Arquivos comparados: 1; abaixo de 99%: 0; citados no JSONL mas ausentes no disco: 1; maior tempo de extração: \d+ ms/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
