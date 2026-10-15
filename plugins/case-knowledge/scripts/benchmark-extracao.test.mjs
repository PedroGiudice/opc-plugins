import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pararExtracoesManuais, pararExtracoesManuaisStream, filtrarPares, tokens, recall, recallSub, resolverCaminho, montarRelatorio } from "./benchmark-extracao.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "benchmark-extracao.mjs");

const uso = (id, command, name = "Bash", description = "Extrair o texto do arquivo") =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command, description } }] } });
// resultado de extração "de verdade": passa do mínimo de 300 caracteres do filtro
const CORPO = "Segue a minuta do contrato revisada. ".repeat(10);
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
      { arquivo: "C:\\a|b.docx", bytes: 1000, ms: 12.4, recall: 0.9, recallSub: 1, tokensManuais: 10, faltantes: [] },
      { arquivo: "C:\\c.xlsx", bytes: 2048, ms: 340.6, recall: 0.5, recallSub: 0.5, tokensManuais: 4, faltantes: ["aaaa", "bbbb"] },
      { arquivo: "C:\\d.eml", bytes: 5, ms: 1, erro: "falhou\nfeio" },
    ],
    ausentes: 2,
    descartados: { porDescricao: 7, porResultado: 3 },
  });
  assert.match(md, /\| Arquivo \| Bytes \| ms \| Recall \| Recall\(sub\) \| Tokens manuais \| Faltantes \(amostra\) \|/);
  assert.match(md, /\| C:\\a\\\|b\.docx \| 1000 \| 12 \| 90\.0% \| 100\.0% \| 10 \|  \|/);
  assert.match(md, /\| C:\\c\.xlsx \| 2048 \| 341 \| 50\.0% \| 50\.0% \| 4 \| aaaa, bbbb \|/);
  assert.match(md, /\| C:\\d\.eml \| 5 \| 1 \| ERRO \| \| \| falhou feio \|/);
  assert.match(md, /Arquivos comparados: 3; abaixo de 99%: 2; citados no JSONL mas ausentes no disco: 2; maior tempo de extração: 341 ms \(C:\\c\.xlsx\); descartados: 7 por descrição, 3 por resultado\./);
});

test("montarRelatorio: sem arquivos comparados", () => {
  const md = montarRelatorio({ linhas: [], ausentes: 1 });
  assert.match(md, /Arquivos comparados: 0; abaixo de 99%: 0; citados no JSONL mas ausentes no disco: 1; maior tempo de extração: n\/d; descartados: 0 por descrição, 0 por resultado\./);
});

test("CLI: compara JSONL com o arquivo em disco, grava só o relatório e nenhum sidecar", () => {
  const raiz = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    const cases = join(raiz, "cases");
    mkdirSync(join(cases, "caso-x"), { recursive: true });
    const eml = join(cases, "caso-x", "msg.eml");
    writeFileSync(eml, `From: Ana <ana@x.com>\r\nTo: bob@x.com\r\nSubject: Contrato\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${CORPO}\r\n`);
    const projects = join(raiz, "projects", "p1");
    mkdirSync(projects, { recursive: true });
    const jsonl = [
      uso("c1", `python ler.py ${eml}`),
      res("c1", CORPO),
      uso("c2", "python ler.py /c/Users/pedro/cases/caso-x/sumiu.msg", "PowerShell"),
      res("c2", CORPO),
    ].join("\n");
    writeFileSync(join(projects, "s.jsonl"), jsonl);
    const antes = readdirSync(join(cases, "caso-x")).sort();
    const saida = join(raiz, "rel.md");
    execFileSync(process.execPath, [SCRIPT, "--projects", join(raiz, "projects"), "--cases", cases, "--saida", saida], { encoding: "utf-8" });
    assert.deepEqual(readdirSync(join(cases, "caso-x")).sort(), antes);
    const md = readFileSync(saida, "utf-8");
    assert.match(md, /\| 100\.0% \| 100\.0% \|/);
    assert.match(md, /Arquivos comparados: 1; abaixo de 99%: 0; citados no JSONL mas ausentes no disco: 1; maior tempo de extração: \d+ ms/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("pararExtracoesManuais: && e || não entram no caminho; segundo caminho depois do && é achado", () => {
  const pares = pararExtracoesManuais([
    uso("q1", "cd /c/Users/pedro/cases/caso-x && python ler.py contrato.docx"),
    res("q1", "x"),
    uso("q2", "cd C:\\Users\\pedro\\cases\\caso-x || python ler.py contrato.docx"),
    res("q2", "x"),
    uso("q3", "cd /c/Users/pedro/cases/caso-x && python ler.py /c/Users/pedro/cases/caso-x/contrato.docx"),
    res("q3", "texto"),
  ]);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].arquivo, "/c/Users/pedro/cases/caso-x/contrato.docx");
});

test("pararExtracoesManuaisStream: iterável assíncrono, linha vazia e não-JSON sem erro", async () => {
  async function* gerar() {
    yield "";
    yield "isto nao e json";
    yield uso("z1", "type C:\\Users\\pedro\\cases\\c\\a.docx");
    yield "";
    yield res("z1", "texto a");
  }
  const pares = await pararExtracoesManuaisStream(gerar());
  assert.deepEqual(pares.map((p) => p.resultado), ["texto a"]);
});

test("CLI: arquivo com linha vazia e não-JSON (CRLF) não derruba; ausente em grafias diferentes conta uma vez", () => {
  const raiz = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    const cases = join(raiz, "cases");
    mkdirSync(join(cases, "caso-x"), { recursive: true });
    const eml = join(cases, "caso-x", "msg.eml");
    writeFileSync(eml, `From: Ana <ana@x.com>\r\nTo: bob@x.com\r\nSubject: Contrato\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${CORPO}\r\n`);
    const projects = join(raiz, "projects", "p1");
    mkdirSync(projects, { recursive: true });
    const jsonl = [
      "",
      "lixo { nao json",
      uso("c1", `python ler.py ${eml}`),
      "",
      res("c1", CORPO),
      uso("c2", "python ler.py /c/Users/pedro/cases/caso-x/sumiu.msg", "PowerShell"),
      res("c2", CORPO),
      uso("c3", "python ler.py C:\\Users\\pedro\\cases\\caso-x\\Sumiu.msg"),
      res("c3", CORPO),
      uso("c4", "python ler.py ~/cases/caso-x/sumiu.msg"),
      res("c4", CORPO),
    ].join("\r\n");
    writeFileSync(join(projects, "s.jsonl"), jsonl);
    const saida = join(raiz, "rel.md");
    execFileSync(process.execPath, [SCRIPT, "--projects", join(raiz, "projects"), "--cases", cases, "--saida", saida], { encoding: "utf-8" });
    const md = readFileSync(saida, "utf-8");
    assert.match(md, /Arquivos comparados: 1; abaixo de 99%: 0; citados no JSONL mas ausentes no disco: 1;/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("pararExtracoesManuais: basename vazio (cases/x/.docx) não é arquivo; guarda a descrição do tool_use", () => {
  const pares = pararExtracoesManuais([
    uso("v1", "ls C:\\Users\\pedro\\cases\\x\\.docx"),
    res("v1", "x"),
    uso("v2", "cat C:\\Users\\pedro\\cases\\x\\a.docx", "Bash", "Ler o contrato"),
    res("v2", "y"),
  ]);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].arquivo, "C:\\Users\\pedro\\cases\\x\\a.docx");
  assert.equal(pares[0].descricao, "Ler o contrato");
});

test("filtrarPares: descrição precisa incluir extração e não excluir; resultado não pode ser ruído ou curto", () => {
  const par = (descricao, resultado, comando = "python x.py C:\\cases\\a.docx") => ({ arquivo: "a", comando, descricao, resultado });
  const bom = CORPO;
  const { mantidos, porDescricao, porResultado } = filtrarPares([
    par("Extrair o texto do contrato", bom),
    par("Imprimir conteúdo da planilha", bom),
    par("Lendo o arquivo (leitura)", bom),
    par("Gerar a minuta e salvar", bom), // exclui: gerar/salvar
    par("Listar a pasta do caso", bom), // exclui: listar
    par("Comparar duas versões e extrair o texto", bom), // inclui mas exclui compar
    par("Abrir o arquivo", bom), // nada que inclua
    par("", bom, "python -c \"print(open('C:\\cases\\a.docx'))\""), // sem descrição: vale o comando
    par("Extrair o texto", "Traceback (most recent call last)\n" + bom),
    par("Extrair o texto", "drwxr-xr-x 2 pedro " + bom),
    par("Extrair o texto", "EISDIR: illegal operation " + bom),
    par("Extrair o texto", "Errno 2 " + bom),
    par("Extrair o texto", "error: " + bom),
    par("Extrair o texto", "curto demais"),
    par("Extrair o texto", "a".repeat(299)),
    par("Extrair o texto", "a".repeat(300)),
  ]);
  // mantidos: 3 primeiros + comando sem descrição + o de 300 caracteres
  assert.equal(mantidos.length, 5);
  assert.equal(porDescricao, 4);
  assert.equal(porResultado, 7);
});

test("recallSub: substring absorve mojibake e colagem; ignora tokens curtos; só confere o que o token exato não achou", () => {
  // manual tem "recomposi" + "ção" quebrados e "pedro" (5) dentro de "pedrosa" no sidecar
  const sidecar = "A recomposição do patrimônio, Pedrosa e Silva, contratação";
  const manual = "recomposi ção patrim nio pedro contrata";
  const sub = recallSub(manual, sidecar);
  // "ção" (3) ignorado; recomposi, patrim, pedro, contrata são substrings (nio tem 3 -> ignorado)
  assert.equal(sub.recall, 1);
  assert.deepEqual(sub.faltantes, []);
  assert.ok(recall(manual, sidecar).recall < 1);
  const sub2 = recallSub("cláusula quarta inexistente", "cláusula quarta");
  assert.equal(sub2.recall, 2 / 3);
  assert.deepEqual(sub2.faltantes, ["inexistente"]);
  assert.deepEqual(recallSub("a bc def", "qualquer"), { recall: 1, faltantes: [] });
});

test("recallSub: não casa através de fronteira de token", () => {
  assert.equal(recallSub("abcd", "ab cd").recall, 0);
});

test("CLI: descarta por descrição e por resultado (contagem no resumo) e --detalhe grava manual e extrator", () => {
  const raiz = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    const cases = join(raiz, "cases");
    mkdirSync(join(cases, "caso-x"), { recursive: true });
    const eml = join(cases, "caso-x", "msg.eml");
    writeFileSync(eml, `From: Ana <ana@x.com>\r\nTo: bob@x.com\r\nSubject: Contrato\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${CORPO}\r\n`);
    const projects = join(raiz, "projects", "p1");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "s.jsonl"), [
      uso("d1", `python ler.py ${eml}`, "Bash", "Gerar relatório e salvar"), // descartado por descrição
      res("d1", CORPO),
      uso("d2", `python ler.py ${eml}`), // descartado por resultado (curto)
      res("d2", "curto"),
      uso("d3", `python ler.py ${eml}`, "Bash", "Extrair o texto do e-mail"), // mantido
      res("d3", CORPO),
    ].join("\n"));
    const saida = join(raiz, "rel.md");
    execFileSync(process.execPath, [SCRIPT, "--projects", join(raiz, "projects"), "--cases", cases, "--saida", saida, "--detalhe", "CASO-X/msg"], { encoding: "utf-8" });
    const md = readFileSync(saida, "utf-8");
    assert.match(md, /Arquivos comparados: 1;.*descartados: 1 por descrição, 1 por resultado\./);
    const detalhe = readFileSync(`${saida}.1.detalhe.md`, "utf-8");
    assert.match(detalhe, /## Manual\n\nSegue a minuta/);
    assert.match(detalhe, /## Extrator\n\n## Cabeçalhos/);
    assert.ok(detalhe.indexOf("## Manual") < detalhe.indexOf("## Extrator"));
    assert.equal(readdirSync(raiz).filter((n) => n.endsWith(".detalhe.md")).length, 1);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
