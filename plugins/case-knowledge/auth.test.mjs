import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  mkdirSync,
  writeFileSync,
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
  await assert.rejects(() => refreshOnce(fakeFetch), /Rode: case-knowledge login/i);
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
