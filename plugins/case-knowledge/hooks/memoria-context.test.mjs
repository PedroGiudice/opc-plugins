import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseSlugFromCwd,
  shouldSkipPrompt,
  formatContext,
  buildHookOutput,
} from "./memoria-context.mjs";

test("caseSlugFromCwd: gate por CASES_BASE (alinhado ao detectCase do server.mjs)", () => {
  const winBase = "C:\\Users\\pedro\\cases";
  assert.equal(
    caseSlugFromCwd("C:\\Users\\pedro\\cases\\oxigenio-retificacao", winBase),
    "oxigenio-retificacao",
  );
  assert.equal(
    caseSlugFromCwd("C:\\Users\\pedro\\cases\\bianka-salesforce\\base", winBase),
    "bianka-salesforce",
  );
  const nixBase = "/home/opc/case-docs/cases";
  assert.equal(
    caseSlugFromCwd("/home/opc/case-docs/cases/0058810-23.2022.8.16.6000", nixBase),
    "0058810-23.2022.8.16.6000",
  );
  // fora da base canonica: outro dir `cases` NAO ativa mais o hook
  assert.equal(caseSlugFromCwd("/tmp/qualquer/cases/foo", nixBase), null);
  assert.equal(caseSlugFromCwd("/home/opc/legal-cogmem", nixBase), null);
  // a raiz da base nao e um caso
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases", winBase), null);
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases\\", winBase), null);
  assert.equal(caseSlugFromCwd("", nixBase), null);
  // sibling-prefix: cases-old NAO e a base cases (classe de bug do startsWith)
  assert.equal(caseSlugFromCwd("/home/opc/case-docs/cases-old/foo", nixBase), null);
  // base de env var com trailing slash funciona
  assert.equal(caseSlugFromCwd("/home/opc/case-docs/cases/meu-caso", "/home/opc/case-docs/cases/"), "meu-caso");
  // cwd Windows com forward slashes (ferramentas que normalizam separador)
  assert.equal(caseSlugFromCwd("C:/Users/pedro/cases/meu-caso/base", winBase), "meu-caso");
  // NTFS e case-insensitive: casing divergente (cwd vs USERPROFILE) nao
  // pode desabilitar o gate silenciosamente (CMR-99 item 1)
  assert.equal(caseSlugFromCwd("c:\\users\\PEDRO\\cases\\meu-caso", winBase), "meu-caso");
  // o slug preserva o casing ORIGINAL do path (collection case-sensitive)
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases\\MeuCaso\\sub", winBase), "MeuCaso");
  // paths POSIX continuam case-sensitive
  assert.equal(caseSlugFromCwd("/home/opc/CASE-DOCS/cases/foo", nixBase), null);
});

test("shouldSkipPrompt: filtros do cogmem.sh", () => {
  assert.equal(shouldSkipPrompt("o que decidimos sobre prescricao?"), false);
  assert.equal(shouldSkipPrompt("curta"), true);              // < 15 chars
  assert.equal(shouldSkipPrompt("/compact agora mesmo"), true); // slash command
  assert.equal(shouldSkipPrompt("ok"), true);                  // trivial
  assert.equal(shouldSkipPrompt("Continue."), true);           // trivial com pontuacao
  assert.equal(shouldSkipPrompt("7"), true);                   // digito
  assert.equal(shouldSkipPrompt(""), true);
});

test("formatContext: bloco com slug, score e conteudo truncado na exibicao", () => {
  const out = formatContext("caso-x", [
    { score: 0.71234, content: "A".repeat(2000) },
    { score: 0.5, content: "decidimos sobre prescricao" },
  ]);
  assert.ok(out.startsWith("MEMORIA DO CASO [caso-x]"));
  assert.ok(out.includes("[0.71]"));
  assert.ok(out.includes("decidimos sobre prescricao"));
  // truncamento de EXIBICAO em 1500 chars por chunk
  assert.ok(!out.includes("A".repeat(1501)));
  assert.ok(out.includes("A".repeat(1500)));
});

test("formatContext: chunks vazios -> null", () => {
  assert.equal(formatContext("caso-x", []), null);
});

test("buildHookOutput embrulha no shape do UserPromptSubmit", () => {
  const o = buildHookOutput("CTX");
  assert.deepEqual(o, {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "CTX",
    },
  });
});
