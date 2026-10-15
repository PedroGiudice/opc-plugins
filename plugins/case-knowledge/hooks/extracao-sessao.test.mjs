import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolverSaidaHook, pastaDoCaso, PREFIXO } from "./extracao-sessao.mjs";

test("resolverSaidaHook: fora de ~/cases devolve {} sem carregar nem chamar o extrator", async () => {
  let chamado = false;
  let importado = false;
  const deps = { importar: async () => { importado = true; return import("../extrair.mjs"); }, extrairCaso: async () => { chamado = true; } };
  assert.deepEqual(await resolverSaidaHook("/outro/lugar", "/home/x/cases", deps), {});
  assert.deepEqual(await resolverSaidaHook("/home/x/cases", "/home/x/cases", deps), {});
  assert.equal(chamado, false);
  assert.equal(importado, false);
});

test("hook: o extrator não é import estático (só carrega dentro de pasta de caso)", () => {
  const texto = readFileSync(new URL("./extracao-sessao.mjs", import.meta.url), "utf-8");
  assert.ok(!/^\s*import\s[^;]*from\s*["']\.\.\/extrair\.mjs["']/m.test(texto));
});

test("hook: stdout recebe só a linha JSON, mesmo com console.* chamado durante a execução", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const caso = join(dir, "caso");
  mkdirSync(caso);
  writeFileSync(join(caso, "a.eml"), "From: a@a\r\nTo: b@b\r\nSubject: s\r\n\r\ncorpo\r\n");
  // O ruído sai de DENTRO da fase de extração (a varredura chama readdirSync),
  // depois de pastaDoCaso, como faria uma lib barulhenta: é esse o caminho que
  // o silêncio do console cobre. Um setTimeout(0) num --import (a versão
  // anterior deste teste) dispara durante a carga assíncrona do grafo de
  // módulos, ANTES de main(); no Windows, com leitura de módulo mais lenta, ele
  // vazava. Em produção nada roda antes do hook, então não era buraco do hook.
  const preload = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const original = fs.readdirSync;",
    'fs.readdirSync = function (...a) { console.log("ruido"); process.stderr.write("ruido-disparado\\n"); return original.apply(this, a); };',
    "syncBuiltinESMExports();",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("./extracao-sessao.mjs", import.meta.url))], {
    input: JSON.stringify({ cwd: caso }),
    env: { ...process.env, CASE_KNOWLEDGE_CASES_BASE: dir },
    encoding: "utf-8",
  });
  assert.ok(r.stderr.includes("ruido-disparado"), `o ruído precisa ter sido disparado: ${r.stderr}`);
  const linhas = r.stdout.split("\n").filter(Boolean);
  assert.equal(linhas.length, 1, r.stdout);
  const out = JSON.parse(linhas[0]);
  assert.ok(out.hookSpecificOutput.additionalContext.includes("- extracoes/a.eml.md ("), out.hookSpecificOutput.additionalContext);
});

test("resolverSaidaHook: na raiz de ~/cases devolve {} (não é pasta de caso)", async () => {
  const out = await resolverSaidaHook("/home/x/cases", "/home/x/cases", { extrairCaso: async () => ({ extraidos: [], adiados: [] }) });
  assert.deepEqual(out, {});
});

test("resolverSaidaHook: subpasta do caso resolve para a pasta do caso e embrulha o resumo", async () => {
  const chamadas = [];
  const out = await resolverSaidaHook("C:\\Users\\p\\cases\\meu-caso\\emails", "C:\\Users\\p\\cases", {
    extrairCaso: async (dir, opts) => { chamadas.push([dir, opts.orcamentoMs, opts.limitePorArquivoMs, opts.maxBytesPorArquivo, typeof opts.falhas]); return { extraidos: [{ rel: "a.docx", sidecar: "a.docx.md", detalhe: "0 revisores, 0 comentários" }], adiados: [], pulados: 0, naoTocados: [], erros: [] }; },
  });
  assert.deepEqual(chamadas, [["C:\\Users\\p\\cases\\meu-caso", 60000, 45000, 5 * 1024 * 1024, "object"]]);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(PREFIXO));
  assert.ok(out.hookSpecificOutput.additionalContext.includes("- a.docx.md (0 revisores, 0 comentários)"));
});

test("resolverSaidaHook: nada extraído nem adiado devolve {}; extrator que lança devolve {}", async () => {
  const vazio = await resolverSaidaHook("/h/cases/c", "/h/cases", { extrairCaso: async () => ({ extraidos: [], adiados: [], pulados: 2, naoTocados: [], erros: [] }) });
  assert.deepEqual(vazio, {});
  const erro = await resolverSaidaHook("/h/cases/c", "/h/cases", { extrairCaso: async () => { throw new Error("x"); } });
  assert.deepEqual(erro, {});
});

test("pastaDoCaso: pastas reservadas e ocultas não são caso; drive do Windows ignora caixa", () => {
  for (const nome of [".memoria", "_archive", "_template", "scripts"]) {
    assert.equal(pastaDoCaso(`/h/cases/${nome}/x`, "/h/cases"), null, nome);
  }
  assert.equal(pastaDoCaso("c:\\users\\p\\cases\\caso\\sub", "C:\\Users\\p\\cases"), "C:\\Users\\p\\cases\\caso");
  assert.equal(pastaDoCaso("/h/cases-outro/c", "/h/cases"), null);
});
