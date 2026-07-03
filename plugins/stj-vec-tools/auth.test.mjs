import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

import {
  readCredential,
  writeCredential,
  getAccessToken,
  decodeJwtExp,
  refreshOnce,
  getFreshAccessToken,
  requestWithAuth,
  credentialPath,
  lockPath,
  genCodeVerifier,
  challengeFromVerifier,
  genState,
  loginFlow,
  openBrowser,
  KEYCHAIN_SERVICE,
} from "./auth.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (exp) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ tenant_id: 1, exp })}.fakesig`;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Aponta AIDVLABS_CREDENTIALS_FILE para um arquivo tmp unico; devolve cleanup. */
function freshCred(t) {
  const dir = mkdtempSync(join(os.tmpdir(), "aidvlabs-cred-"));
  const file = join(dir, "aidvlabs", "credentials.json");
  process.env.AIDVLABS_CREDENTIALS_FILE = file;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test("writeCredential/readCredential: round-trip + modo 0600 no POSIX", (t) => {
  const file = freshCred(t);
  const cred = { access_jwt: "a.b.c", refresh: "r1" };
  const written = writeCredential(cred);
  assert.equal(written, file);
  assert.equal(credentialPath(), file);
  assert.deepEqual(readCredential(), cred);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("readCredential: ausente -> null; corrompido -> null", (t) => {
  const file = freshCred(t);
  assert.equal(readCredential(), null);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ nao e json valido");
  assert.equal(readCredential(), null);
});

test("openBrowser: comando por plataforma, URL integra como argumento (sem truncar nos &)", () => {
  const url = "https://app.aidvlabs.com/cli/authorize?response_type=code&redirect_uri=http://127.0.0.1:5500/callback&code_challenge=abc123&state=xyz789";
  const cap = (platform) => {
    const calls = [];
    openBrowser(url, (cmd, args) => {
      calls.push({ cmd, args });
      return { unref() {} };
    }, platform);
    return calls[0];
  };
  // win32: rundll32 (.exe direto, sem cmd) -- nao trunca a URL no 1o `&`.
  assert.deepEqual(cap("win32"), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  assert.deepEqual(cap("darwin"), { cmd: "open", args: [url] });
  assert.deepEqual(cap("linux"), { cmd: "xdg-open", args: [url] });
  // a URL completa (com redirect_uri/state apos os `&`) chega intacta em todas.
  for (const p of ["win32", "darwin", "linux"]) {
    assert.ok(cap(p).args.at(-1).includes("redirect_uri"));
    assert.ok(cap(p).args.at(-1).includes("state=xyz789"));
  }
});

test("getAccessToken: sem credencial lanca mensagem acionavel", (t) => {
  freshCred(t);
  assert.throws(() => getAccessToken(), /Sem credencial.*login/i);
});

test("decodeJwtExp: extrai exp de JWT fabricado; lixo -> null", () => {
  const exp = 1893456000;
  assert.equal(decodeJwtExp(makeJwt(exp)), exp);
  assert.equal(decodeJwtExp("nao-e-um-jwt"), null);
  assert.equal(decodeJwtExp(""), null);
  assert.equal(decodeJwtExp(null), null);
  assert.equal(decodeJwtExp(undefined), null);
  // payload valido sem claim exp -> null
  assert.equal(decodeJwtExp(`${b64({})}.${b64({ tenant_id: 1 })}.sig`), null);
});

test("refreshOnce: 2xx grava novo par e retorna access_jwt", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: "old", refresh: "r-old" });
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_jwt: "new-jwt", refresh: "r-new", expires_in: 900 }),
    };
  };
  const out = await refreshOnce(fakeFetch);
  assert.equal(out, "new-jwt");
  assert.ok(captured.url.endsWith("/cli/token/refresh"));
  assert.equal(captured.body.refresh, "r-old");
  assert.deepEqual(readCredential(), { access_jwt: "new-jwt", refresh: "r-new" });
});

test("refreshOnce: 401 (revogado) lanca 'rode login'", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: "old", refresh: "r-old" });
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "revoked" });
  await assert.rejects(() => refreshOnce(fakeFetch), /Rode: node .*server\.mjs login/i);
});

test("refreshOnce: sem credencial lanca acionavel (nao tenta rede)", async (t) => {
  freshCred(t);
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  await assert.rejects(() => refreshOnce(fakeFetch), /login/i);
  assert.equal(called, false);
});

test("getFreshAccessToken: token longe de expirar nao refresca", async (t) => {
  freshCred(t);
  const jwt = makeJwt(nowSec() + 3600);
  writeCredential({ access_jwt: jwt, refresh: "r1" });
  let refreshCalls = 0;
  const fakeFetch = async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({ access_jwt: "x", refresh: "y" }) }; };
  const out = await getFreshAccessToken(fakeFetch);
  assert.equal(out, jwt);
  assert.equal(refreshCalls, 0);
});

test("getFreshAccessToken: token expirando (<60s) refresca proativamente", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: makeJwt(nowSec() + 10), refresh: "r1" });
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ access_jwt: "fresh", refresh: "r2" }) });
  const out = await getFreshAccessToken(fakeFetch);
  assert.equal(out, "fresh");
});

test("requestWithAuth: 200 direto, sem refresh, com Bearer atual", async (t) => {
  freshCred(t);
  const jwt = makeJwt(nowSec() + 3600);
  writeCredential({ access_jwt: jwt, refresh: "r1" });
  let refreshCalls = 0;
  const fakeFetch = async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({}) }; };
  const seen = [];
  const doFetch = async (h) => { seen.push(h); return { ok: true, status: 200 }; };
  const res = await requestWithAuth(doFetch, fakeFetch);
  assert.equal(res.status, 200);
  assert.equal(refreshCalls, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].Authorization, `Bearer ${jwt}`);
});

test("requestWithAuth: 401 -> refresh -> 200 (1 retry, novo Bearer)", async (t) => {
  freshCred(t);
  const jwt = makeJwt(nowSec() + 3600);
  writeCredential({ access_jwt: jwt, refresh: "r1" });
  let refreshCalls = 0;
  const fakeFetch = async () => { refreshCalls++; return { ok: true, status: 200, json: async () => ({ access_jwt: "jwt2", refresh: "r2" }) }; };
  const seen = [];
  const doFetch = async (h) => {
    seen.push(h);
    return seen.length === 1 ? { ok: false, status: 401 } : { ok: true, status: 200 };
  };
  const res = await requestWithAuth(doFetch, fakeFetch);
  assert.equal(res.status, 200);
  assert.equal(refreshCalls, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].Authorization, `Bearer ${jwt}`);
  assert.equal(seen[1].Authorization, "Bearer jwt2");
});

test("requestWithAuth: 401 -> refresh -> 401 lanca erro acionavel", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: makeJwt(nowSec() + 3600), refresh: "r1" });
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ access_jwt: "jwt2", refresh: "r2" }) });
  const doFetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => requestWithAuth(doFetch, fakeFetch),
    /Nao autorizado \(401\) apos refresh.*login/i,
  );
});

test("requestWithAuth: 401 + refresh revogado (401) lanca erro acionavel", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: makeJwt(nowSec() + 3600), refresh: "r1" });
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "revoked" });
  const doFetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => requestWithAuth(doFetch, fakeFetch),
    /Nao autorizado \(401\) apos refresh.*login/i,
  );
});

test("requestWithAuth: sem credencial degrada para sem Bearer (compat tailnet)", async (t) => {
  freshCred(t); // arquivo nao existe
  const fakeFetch = async () => { throw new Error("refresh nao deveria ser chamado"); };
  const seen = [];
  const doFetch = async (h) => { seen.push(h); return { ok: true, status: 200 }; };
  const res = await requestWithAuth(doFetch, fakeFetch);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {}); // sem header Authorization
});

test("requestWithAuth: refresh proativo falho -> best-effort com token atual; 200 nao quebra", async (t) => {
  freshCred(t);
  const jwt = makeJwt(nowSec() + 10); // expirando -> dispara proativo
  writeCredential({ access_jwt: jwt, refresh: "r1" });
  // refresh proativo falha (401); a API, porem, ainda aceita o token atual.
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "revoked" });
  const seen = [];
  const doFetch = async (h) => { seen.push(h); return { ok: true, status: 200 }; };
  const res = await requestWithAuth(doFetch, fakeFetch);
  assert.equal(res.status, 200);
  assert.equal(seen[0].Authorization, `Bearer ${jwt}`); // usou o token atual
});

test("requestWithAuth: status nao-ok != 401 retorna a Response ao caller", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: makeJwt(nowSec() + 3600), refresh: "r1" });
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const doFetch = async () => ({ ok: false, status: 500 });
  const res = await requestWithAuth(doFetch, fakeFetch);
  assert.equal(res.status, 500); // caller decide (mantem "API 500: ...")
});

test("refreshOnce: resposta sem refresh preserva o refresh atual (defensivo)", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: "old", refresh: "r-keep" });
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ access_jwt: "novo" }) });
  const out = await refreshOnce(fakeFetch);
  assert.equal(out, "novo");
  assert.deepEqual(readCredential(), { access_jwt: "novo", refresh: "r-keep" });
});

// --- PKCE ---

test("challengeFromVerifier: vetor RFC 7636 Appendix B", () => {
  assert.equal(
    challengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("genCodeVerifier: base64url no range 43-128 (RFC 7636), aleatorio", () => {
  const v = genCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/); // base64url sem padding
  assert.ok(v.length >= 43 && v.length <= 128, `len=${v.length}`);
  assert.notEqual(genCodeVerifier(), genCodeVerifier());
});

test("genState: nao-vazio e base64url", () => {
  const s = genState();
  assert.ok(s.length > 0);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
});

// --- loginFlow (loopback real + fetch/opener mockados) ---

test("loginFlow: callback valido troca code, grava credencial e resolve", async (t) => {
  freshCred(t); // AIDVLABS_CREDENTIALS_FILE -> storage em arquivo (deterministico)
  let tokenBody = null;
  const fetchImpl = async (url, opts) => {
    assert.ok(String(url).endsWith("/cli/token"));
    tokenBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_jwt: "jwt-login", refresh: "r-login", expires_in: 900 }),
    };
  };
  let authParams = null;
  // Simula o browser: le a URL de authorize e bate no loopback com code+state.
  const openImpl = (urlStr) => {
    const u = new URL(urlStr);
    assert.ok(u.pathname.endsWith("/cli/authorize"));
    authParams = {
      redirect_uri: u.searchParams.get("redirect_uri"),
      state: u.searchParams.get("state"),
      challenge: u.searchParams.get("code_challenge"),
      method: u.searchParams.get("code_challenge_method"),
      response_type: u.searchParams.get("response_type"),
    };
    const cb = new URL(authParams.redirect_uri);
    cb.searchParams.set("code", "opaque-code-123");
    cb.searchParams.set("state", authParams.state);
    fetch(cb).catch(() => {}); // fire-and-forget no loopback real
  };
  const out = await loginFlow({ fetchImpl, openImpl, log: () => {}, timeoutMs: 10_000 });
  assert.equal(out, true);
  assert.deepEqual(readCredential(), { access_jwt: "jwt-login", refresh: "r-login" });
  // PKCE S256: o challenge da URL bate com o verifier enviado na troca.
  assert.equal(authParams.method, "S256");
  assert.equal(authParams.response_type, "code");
  assert.equal(challengeFromVerifier(tokenBody.code_verifier), authParams.challenge);
  // redirect_uri loopback literal, path exato, SEM query/fragment.
  const ru = new URL(authParams.redirect_uri);
  assert.equal(ru.protocol, "http:");
  assert.equal(ru.hostname, "127.0.0.1");
  assert.equal(ru.pathname, "/callback");
  assert.equal(ru.search, "");
  assert.equal(ru.hash, "");
});

test("loginFlow: callback com state errado -> 400, nao grava, timeout", async (t) => {
  freshCred(t);
  const fetchImpl = async () => {
    throw new Error("/cli/token nao deveria ser chamado com state invalido");
  };
  let badStatus = null;
  const openImpl = async (urlStr) => {
    const u = new URL(urlStr);
    const cb = new URL(u.searchParams.get("redirect_uri"));
    cb.searchParams.set("code", "x");
    cb.searchParams.set("state", "STATE-ERRADO");
    const r = await fetch(cb);
    badStatus = r.status;
  };
  await assert.rejects(
    () => loginFlow({ fetchImpl, openImpl, log: () => {}, timeoutMs: 400 }),
    /Tempo esgotado/i,
  );
  assert.equal(badStatus, 400);
  assert.equal(readCredential(), null); // nada gravado
});

// --- Keychain compartilhado entre os 3 plugins (aidvlabs-mcp) ---

test("KEYCHAIN_SERVICE e 'aidvlabs-mcp' (1 login serve os 3 plugins)", () => {
  assert.equal(KEYCHAIN_SERVICE, "aidvlabs-mcp");
});

// --- D7: lock de refresh concorrente (MCP + sync compartilham a credencial) ---

test("refreshOnce: 2 concorrentes -> 1 rotaciona, o outro reusa (D7 lock)", async (t) => {
  freshCred(t); // AIDVLABS_CREDENTIALS_FILE -> storage em arquivo (lock no mesmo dir)
  writeCredential({ access_jwt: "old", refresh: "r-old" });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30)); // segura o lock enquanto o outro espera
    return { ok: true, status: 200, json: async () => ({ access_jwt: "rotated", refresh: "r-new" }) };
  };
  const [a, b] = await Promise.all([refreshOnce(fetchImpl), refreshOnce(fetchImpl)]);
  assert.equal(calls, 1); // so um bateu na rede
  assert.equal(a, "rotated");
  assert.equal(b, "rotated"); // o segundo reusou a credencial ja rotacionada
  assert.deepEqual(readCredential(), { access_jwt: "rotated", refresh: "r-new" });
});

// Correcao do D7: com LOCK_STALE_MS < REFRESH_TIMEOUT_MS o antigo lock roubava
// de holder VIVO (rotacao dupla). Agora so rouba de holder genuinamente morto
// (mtime > LOCK_STALE_MS = 90s > budget de refresh 60s).
test("refreshOnce: rouba lock STALE de holder morto e rotaciona 1x (D7 timings)", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: "old", refresh: "r-old" });
  // Pre-cria o lock de um "holder morto" com mtime bem antigo (> LOCK_STALE_MS).
  const lp = lockPath();
  mkdirSync(dirname(lp), { recursive: true });
  writeFileSync(lp, "111111:1"); // token de outro pid (irrelevante ao roubo)
  const past = new Date(Date.now() - 120_000); // 120s > 90s stale
  utimesSync(lp, past, past);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ access_jwt: "rotated", refresh: "r-new" }) };
  };
  const out = await refreshOnce(fetchImpl);
  assert.equal(out, "rotated");
  assert.equal(calls, 1); // roubou o stale e rotacionou (nao travou ate o deadline)
  assert.deepEqual(readCredential(), { access_jwt: "rotated", refresh: "r-new" });
});

// Correcao do D7: releaseLock so apaga o proprio lock. Se outro detentor
// substituiu o arquivo (roubo como stale + recriacao), o release do holder
// original NAO pode apagar o lock do novo dono (quebraria a exclusao mutua).
test("releaseLock: nao apaga lock substituido por OUTRO detentor (posse por token)", async (t) => {
  freshCred(t);
  writeCredential({ access_jwt: "old", refresh: "r-old" });
  const FOREIGN = "999999:424242"; // token de um "novo detentor"
  const fetchImpl = async () => {
    // Enquanto ESTE holder faz a rede (segurando o lock), simula outro processo
    // assumindo o lock: sobrescreve o arquivo com um token diferente.
    writeFileSync(lockPath(), FOREIGN);
    return { ok: true, status: 200, json: async () => ({ access_jwt: "rotated", refresh: "r-new" }) };
  };
  await refreshOnce(fetchImpl);
  // O release viu conteudo != seu token -> preservou o lock do "novo detentor".
  assert.ok(existsSync(lockPath()), "lock do novo detentor foi apagado indevidamente");
  assert.equal(readFileSync(lockPath(), "utf-8"), FOREIGN);
});
