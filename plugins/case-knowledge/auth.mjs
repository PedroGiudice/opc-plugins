/**
 * Runtime de autenticacao do plugin case-knowledge.
 *
 * Le uma credencial { access_jwt, refresh } de um arquivo local (o login que
 * escreve o arquivo e outra task), injeta o Bearer nas chamadas a API Rust
 * (case-knowledge-api) e renova o token: proativamente (perto de expirar) e
 * reativamente (em 401). O token e por-tenant: um login por usuario/maquina
 * serve todas as pastas de caso.
 *
 * DOIS base URLs distintos:
 *   - API_BASE (server.mjs): a API Rust onde as tools batem. NAO vive aqui.
 *   - APP_BASE (este modulo): o app Laravel publico onde /cli/token* vivem.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

/** App Laravel publico (login/troca/refresh de token). NAO e a API Rust. */
export const APP_BASE =
  process.env.CASE_KNOWLEDGE_APP_BASE || "https://app.aidvlabs.com";

/** Mesmo timeout do server.mjs (REQUEST_TIMEOUT_MS). */
const REFRESH_TIMEOUT_MS = 60_000;

/** Comando de login, centralizado para a task de login ajustar em 1 lugar. */
const LOGIN_CMD = "case-knowledge login";
const MSG_NO_CREDENTIAL = `Sem credencial. Rode: ${LOGIN_CMD}`;
const MSG_SESSION_EXPIRED = `Sessao expirada ou revogada. Rode: ${LOGIN_CMD}`;
const MSG_UNAUTHORIZED_AFTER_REFRESH = `Nao autorizado (401) apos refresh. Rode: ${LOGIN_CMD}`;

/** Erro tipado: ausencia de credencial degrada para "sem Bearer" (compat tailnet). */
function noCredentialError() {
  const e = new Error(MSG_NO_CREDENTIAL);
  e.code = "NO_CREDENTIAL";
  return e;
}

/**
 * Caminho cross-platform do arquivo de credencial.
 * Override via AIDVLABS_CREDENTIALS_FILE (util para teste).
 */
export function credentialPath() {
  if (process.env.AIDVLABS_CREDENTIALS_FILE) {
    return process.env.AIDVLABS_CREDENTIALS_FILE;
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || join(os.homedir(), "AppData", "Roaming");
    return join(appData, "aidvlabs", "credentials.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config");
  return join(configHome, "aidvlabs", "credentials.json");
}

/** Le a credencial; retorna { access_jwt, refresh } ou null (ausente/corrompida). */
export function readCredential() {
  const path = credentialPath();
  if (!existsSync(path)) return null;
  try {
    const cred = JSON.parse(readFileSync(path, "utf-8"));
    if (!cred || typeof cred !== "object") return null;
    return cred;
  } catch {
    return null;
  }
}

/**
 * Grava a credencial: cria o diretorio e escreve JSON com modo restritivo
 * 0o600 no POSIX (chmod garante a permissao mesmo em sobrescrita).
 */
export function writeCredential(cred) {
  const path = credentialPath();
  const posix = process.platform !== "win32";
  mkdirSync(dirname(path), { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
  const json = JSON.stringify(cred, null, 2);
  writeFileSync(path, json, posix ? { encoding: "utf-8", mode: 0o600 } : "utf-8");
  if (posix) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort: em FS sem suporte a chmod, segue sem travar
    }
  }
  return path;
}

/** access_jwt cru da credencial, ou null (sem lancar). */
function currentAccessTokenOrNull() {
  const cred = readCredential();
  return cred && typeof cred.access_jwt === "string" && cred.access_jwt
    ? cred.access_jwt
    : null;
}

/**
 * Retorna o access_jwt atual; lanca NO_CREDENTIAL se ausente.
 * Mensagem clara e acionavel.
 */
export function getAccessToken() {
  const token = currentAccessTokenOrNull();
  if (!token) throw noCredentialError();
  return token;
}

/**
 * Decodifica o payload do JWT (base64url do meio) SEM verificar assinatura
 * e retorna o claim `exp` (segundos epoch) ou null se nao parseavel.
 */
export function decodeJwtExp(jwt) {
  try {
    if (typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Troca o refresh por um novo par (rotacao). POST {APP_BASE}/cli/token/refresh.
 * 2xx -> grava { access_jwt, refresh } e retorna o novo access_jwt.
 * nao-2xx (ex. 401 = refresh revogado) -> lanca mensagem acionavel.
 */
export async function refreshOnce(fetchImpl = fetch) {
  const cred = readCredential();
  if (!cred || !cred.refresh) throw noCredentialError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${APP_BASE}/cli/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: cred.refresh }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(MSG_SESSION_EXPIRED);

  const data = await res.json();
  if (!data || typeof data.access_jwt !== "string" || !data.access_jwt) {
    throw new Error(MSG_SESSION_EXPIRED);
  }
  writeCredential({ access_jwt: data.access_jwt, refresh: data.refresh });
  return data.access_jwt;
}

/**
 * Token usavel: o atual, mas se expira em <60s (ou ja expirou) refresca antes
 * (refresh PROATIVO). Lanca NO_CREDENTIAL se nao ha credencial.
 */
export async function getFreshAccessToken(fetchImpl = fetch) {
  const token = getAccessToken();
  const exp = decodeJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp !== null && exp - now < 60) {
    return await refreshOnce(fetchImpl);
  }
  return token;
}

/**
 * Executa uma request com Bearer injetado, refresh PROATIVO (best-effort) e
 * refresh REATIVO em 401 (1 retry). `doFetch(authHeaders)` recebe os headers
 * de auth a mesclar e retorna a Response (ja com retry de rede do server).
 *
 * Semantica:
 *  - Sem credencial -> segue SEM Bearer (compat tailnet require_bearer=false);
 *    so o 401 efetivo dispara o erro "rode login".
 *  - Refresh proativo que falha -> best-effort: usa o token atual e deixa o
 *    401 reativo (se houver) emitir o erro acionavel.
 *  - 401 -> refreshOnce 1x + repete; se ainda 401 (ou refresh falha) -> lanca
 *    "Nao autorizado (401) apos refresh. Rode: <login>".
 *  - Outros status nao-ok: retorna a Response; o caller mantem o comportamento
 *    atual (lanca "API <status>: <body>").
 */
export async function requestWithAuth(doFetch, fetchImpl = fetch) {
  let token = null;
  try {
    token = await getFreshAccessToken(fetchImpl);
  } catch (err) {
    if (err && err.code === "NO_CREDENTIAL") {
      token = null; // degrade: sem credencial -> sem Bearer
    } else {
      // Refresh proativo falhou de verdade: best-effort com o token atual.
      token = currentAccessTokenOrNull();
    }
  }

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  let res = await doFetch(authHeaders);

  if (res.status === 401) {
    let newToken;
    try {
      newToken = await refreshOnce(fetchImpl);
    } catch {
      throw new Error(MSG_UNAUTHORIZED_AFTER_REFRESH);
    }
    res = await doFetch({ Authorization: `Bearer ${newToken}` });
    if (res.status === 401) throw new Error(MSG_UNAUTHORIZED_AFTER_REFRESH);
  }

  return res;
}
