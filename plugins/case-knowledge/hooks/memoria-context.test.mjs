import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import {
  caseSlugFromCwd,
  shouldSkipPrompt,
  formatContext,
  buildHookOutput,
  contextHeaders,
  readCredentialSafe,
  fetchContext,
  defaultMemApiBase,
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

// --- Bearer (CMR-135): sincrono, sem refresh, degrade sem credencial ---

test("contextHeaders: Bearer so quando ha access_jwt utilizavel", () => {
  assert.deepEqual(contextHeaders(null), { "Content-Type": "application/json" });
  assert.deepEqual(contextHeaders(undefined), { "Content-Type": "application/json" });
  assert.deepEqual(contextHeaders({}), { "Content-Type": "application/json" });
  // credencial so com refresh (login parcial) nao vira Bearer
  assert.deepEqual(contextHeaders({ refresh: "r1" }), {
    "Content-Type": "application/json",
  });
  // access_jwt vazio ou de tipo errado nao vira Bearer
  assert.deepEqual(contextHeaders({ access_jwt: "" }), {
    "Content-Type": "application/json",
  });
  assert.deepEqual(contextHeaders({ access_jwt: 42 }), {
    "Content-Type": "application/json",
  });
  assert.deepEqual(contextHeaders({ access_jwt: "a.b.c", refresh: "r1" }), {
    "Content-Type": "application/json",
    Authorization: "Bearer a.b.c",
  });
});

/** AIDVLABS_CREDENTIALS_FILE bypassa o keychain -> deterministico no teste. */
function credFixture(t, cred) {
  const dir = mkdtempSync(join(os.tmpdir(), "aidvlabs-hook-"));
  const file = join(dir, "aidvlabs", "credentials.json");
  const prev = process.env.AIDVLABS_CREDENTIALS_FILE;
  process.env.AIDVLABS_CREDENTIALS_FILE = file;
  if (cred) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cred), "utf-8");
  }
  t.after(() => {
    if (prev === undefined) delete process.env.AIDVLABS_CREDENTIALS_FILE;
    else process.env.AIDVLABS_CREDENTIALS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("readCredentialSafe: le a credencial local; ausente/corrompida -> null", (t) => {
  credFixture(t, { access_jwt: "a.b.c", refresh: "r1" });
  assert.deepEqual(readCredentialSafe(), { access_jwt: "a.b.c", refresh: "r1" });
});

test("readCredentialSafe: sem arquivo -> null (nunca lanca)", (t) => {
  credFixture(t);
  assert.equal(readCredentialSafe(), null);
});

test("fetchContext: manda o Bearer da credencial lida", async (t) => {
  credFixture(t, { access_jwt: "a.b.c", refresh: "r1" });
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ status: "ok", chunks: [{ score: 1, content: "x" }] }) };
  };
  const chunks = await fetchContext("prompt de teste valido", "/x/cases/y", fakeFetch);
  assert.ok(captured.url.endsWith("/context"));
  assert.equal(captured.headers.Authorization, "Bearer a.b.c");
  assert.equal(captured.body.repo_path, "/x/cases/y");
  assert.equal(chunks.length, 1);
});

test("fetchContext: sem credencial -> sem Authorization, segue funcionando", async (t) => {
  credFixture(t);
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { headers: opts.headers };
    return { ok: true, json: async () => ({ status: "ok", chunks: [] }) };
  };
  const chunks = await fetchContext("prompt de teste valido", "/x/cases/y", fakeFetch);
  assert.equal(captured.headers.Authorization, undefined);
  assert.deepEqual(chunks, []);
});

test("fetchContext: 401 (token vencido) -> null, sem refresh e sem lancar", async (t) => {
  credFixture(t, { access_jwt: "a.b.c", refresh: "r1" });
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 401 };
  };
  const chunks = await fetchContext("prompt de teste valido", "/x/cases/y", fakeFetch);
  assert.equal(chunks, null);
  // UMA unica chamada: o hook NAO tenta refresh (budget de 10s do hook)
  assert.equal(calls, 1);
});

// --- CMR-135 Task 6b: default por plataforma (duplicado de memoria.mjs) ---

test("defaultMemApiBase (hook): win32 -> URL publica; unix -> tailnet", () => {
  assert.equal(defaultMemApiBase("win32"), "https://cogmem.aidvlabs.com/api");
  assert.equal(defaultMemApiBase("linux"), "http://100.123.73.128:3940/api");
});

test("defaultMemApiBase (hook): sem argumento usa a plataforma do processo", () => {
  assert.equal(defaultMemApiBase(), defaultMemApiBase(process.platform));
});
