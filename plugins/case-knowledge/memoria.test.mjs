import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { memoriaSearch, formatMemoriaResults, defaultMemApiBase, originLabel } from "./memoria.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (exp) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ tenant_id: 1, exp })}.fakesig`;

/**
 * Aponta AIDVLABS_CREDENTIALS_FILE para um arquivo tmp unico (o override
 * BYPASSA o keychain do SO -> deterministico e sem tocar a credencial real da
 * maquina). Grava a credencial se `cred` vier; senao o arquivo nao existe e
 * readCredential devolve null. Devolve cleanup via t.after.
 */
function credFixture(t, cred) {
  const dir = mkdtempSync(join(os.tmpdir(), "aidvlabs-memoria-"));
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
  return file;
}

/** Fake fetch que captura headers e devolve 1 chunk. */
function okFetch(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.headers = opts.headers;
    return {
      ok: true,
      json: async () => ({ status: "ok", chunks: [{ score: 0.5, content: "c" }] }),
    };
  };
}

test("memoriaSearch monta o request e formata resultados", async (t) => {
  credFixture(t); // sem credencial: nao toca o keychain real da maquina
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({
        status: "ok",
        chunks: [{ score: 0.8, content: "decidimos X", session_id: "s1", timestamp: "2026-06-10T00:00:00Z" }],
      }),
    };
  };
  const out = await memoriaSearch(
    { query: "o que decidimos", limit: 3 },
    { dir: "C:\\Users\\pedro\\cases\\caso-x", name: "caso-x" },
    fakeFetch,
  );
  assert.ok(captured.url.endsWith("/search"));
  assert.equal(captured.body.repo_path, "C:\\Users\\pedro\\cases\\caso-x");
  assert.equal(captured.body.limit, 3);
  assert.ok(out.includes("decidimos X"));
  assert.ok(out.includes("0.80"));
});

test("memoriaSearch: sem resultados -> mensagem amigavel", async (t) => {
  credFixture(t);
  const fakeFetch = async () => ({ ok: true, json: async () => ({ status: "ok", chunks: [] }) });
  const out = await memoriaSearch({ query: "q de teste valida" }, { dir: "/x/cases/y", name: "y" }, fakeFetch);
  assert.ok(out.includes("nenhuma memoria"));
});

test("memoriaSearch: erro HTTP -> mensagem legivel, sem throw", async (t) => {
  credFixture(t);
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const out = await memoriaSearch({ query: "q de teste valida" }, { dir: "/x/cases/y", name: "y" }, fakeFetch);
  assert.ok(out.toLowerCase().includes("indisponivel"));
});

test("memoriaSearch: com credencial -> Authorization Bearer no request", async (t) => {
  const jwt = makeJwt(Math.floor(Date.now() / 1000) + 3600); // longe de expirar
  credFixture(t, { access_jwt: jwt, refresh: "r1" });
  const captured = {};
  const out = await memoriaSearch(
    { query: "o que decidimos" },
    { dir: "/x/cases/y", name: "y" },
    okFetch(captured),
  );
  assert.equal(captured.headers.Authorization, `Bearer ${jwt}`);
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.ok(out.includes("c"));
});

test("memoriaSearch: sem credencial -> sem Authorization e sem crash", async (t) => {
  credFixture(t); // arquivo inexistente -> readCredential null
  const captured = {};
  const out = await memoriaSearch(
    { query: "o que decidimos" },
    { dir: "/x/cases/y", name: "y" },
    okFetch(captured),
  );
  assert.equal(captured.headers.Authorization, undefined);
  assert.equal(captured.headers["Content-Type"], "application/json");
  assert.ok(out.includes("c"));
});

// --- CMR-135 Task 6b: default por plataforma ---

test("defaultMemApiBase: win32 -> URL publica; unix -> tailnet", () => {
  assert.equal(defaultMemApiBase("win32"), "https://cogmem.aidvlabs.com/api");
  assert.equal(defaultMemApiBase("linux"), "http://100.123.73.128:3940/api");
  assert.equal(defaultMemApiBase("darwin"), "http://100.123.73.128:3940/api");
});

test("defaultMemApiBase: sem argumento usa a plataforma do processo", () => {
  assert.equal(defaultMemApiBase(), defaultMemApiBase(process.platform));
});

// ---------------------------------------------------------------------------
// originLabel (atribuicao de origem por repo_path, CMR-154)

test("originLabel: path Windows -> username", () => {
  assert.equal(originLabel("C:\\Users\\anabeatriz\\cases\\angatu-priscila"), "anabeatriz");
  assert.equal(originLabel("C:\\Users\\pedro\\cases\\x"), "pedro");
});

test("originLabel: path Windows com barras normais -> username", () => {
  assert.equal(originLabel("C:/Users/pedro/cases/x"), "pedro");
});

test("originLabel: VM (/home/...) -> vm", () => {
  assert.equal(originLabel("/home/opc/case-docs/cases/angatu-priscila"), "vm");
});

test("originLabel: ausente/estranho -> null", () => {
  assert.equal(originLabel(null), null);
  assert.equal(originLabel(""), null);
  assert.equal(originLabel("D:\\outra\\coisa"), null);
  assert.equal(originLabel(42), null);
});

test("formatMemoriaResults: inclui origem e data quando presentes", () => {
  const out = formatMemoriaResults([
    {
      score: 0.82,
      timestamp: "2026-07-31T15:45:12.483Z",
      session_id: "abc-123",
      repo_path: "C:\\Users\\pedro\\cases\\angatu-priscila",
      content: "decidimos a tese X",
    },
  ]);
  assert.match(out, /\[0\.82\]/);
  assert.match(out, /pedro/);
  assert.match(out, /2026-07-31/);
  assert.match(out, /decidimos a tese X/);
});

test("formatMemoriaResults: sem repo_path segue funcionando (chunk antigo)", () => {
  const out = formatMemoriaResults([
    { score: 0.5, timestamp: "2026-07-01T00:00:00Z", session_id: "s", content: "c" },
  ]);
  assert.match(out, /\[0\.50\]/);
  assert.match(out, /c/);
});
