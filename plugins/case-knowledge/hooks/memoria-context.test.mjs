import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseSlugFromCwd,
  shouldSkipPrompt,
  formatContext,
  buildHookOutput,
} from "./memoria-context.mjs";

test("caseSlugFromCwd: Windows, Unix, fora de caso", () => {
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases\\oxigenio-retificacao"), "oxigenio-retificacao");
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases\\bianka-salesforce\\base"), "bianka-salesforce");
  assert.equal(caseSlugFromCwd("/home/opc/case-docs/cases/0058810-23.2022.8.16.6000"), "0058810-23.2022.8.16.6000");
  assert.equal(caseSlugFromCwd("/home/opc/legal-cogmem"), null);
  assert.equal(caseSlugFromCwd("C:\\Users\\pedro\\cases"), null);
  assert.equal(caseSlugFromCwd(""), null);
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
