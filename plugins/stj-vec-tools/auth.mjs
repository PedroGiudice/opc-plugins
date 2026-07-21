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

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** App Laravel publico (login/troca/refresh de token). NAO e a API Rust. */
export const APP_BASE =
  process.env.CASE_KNOWLEDGE_APP_BASE || "https://app.aidvlabs.com";

/** Mesmo timeout do server.mjs (REQUEST_TIMEOUT_MS). */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Comando de login concreto. Em runtime do MCP server, CLAUDE_PLUGIN_ROOT esta
 * no env (set pelo Claude Code) -> caminho absoluto do server.mjs; fora dele
 * (shell do usuario, testes) cai num placeholder claro. O subcomando real e
 * `node <server.mjs> login` (mesmo entrypoint do .mcp.json).
 */
function loginCommand() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const target = root ? join(root, "server.mjs") : "<plugin>/server.mjs";
  return `node ${target} login`;
}
const LOGIN_CMD = loginCommand();
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

// --- Storage: keychain do SO com fallback para arquivo 0600 ---

/** Identidade da credencial no keychain do SO (1 por usuario/maquina).
 * COMPARTILHADO pelos 3 plugins MCP (case-knowledge, stj-vec-tools,
 * legal-vec-tools): um unico login popula esta entrada e serve os tres. */
export const KEYCHAIN_SERVICE = "aidvlabs-mcp";
const KEYCHAIN_ACCOUNT = "default";

/** Cache do modulo keyring: undefined=nao tentado | null=indisponivel | modulo. */
let keyringModuleCache;

/**
 * Carrega @napi-rs/keyring de forma LAZY e tolerante a falha.
 *
 * Usa createRequire (sincrono) em vez de import() assincrono DE PROPOSITO:
 * readCredential/writeCredential sao sincronos (contrato do cliente-1 e dos
 * testes); um import() forcaria todo o storage a virar async, quebrando os
 * callers. O require sincrono atende ao mesmo objetivo (carga lazy, em
 * try/catch, sem dependencia hard no topo do modulo): se a dep nativa nao
 * existir/carregar (sem prebuild, libsecret/D-Bus ausente headless) -> null e
 * o storage cai para arquivo. NUNCA lanca.
 */
function loadKeyring() {
  if (keyringModuleCache !== undefined) return keyringModuleCache;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@napi-rs/keyring");
    keyringModuleCache = mod && typeof mod.Entry === "function" ? mod : null;
  } catch {
    keyringModuleCache = null;
  }
  return keyringModuleCache;
}

/**
 * Entry do keychain para esta credencial, ou null se devemos usar arquivo.
 * O override AIDVLABS_CREDENTIALS_FILE forca arquivo (bypassa keychain) — usado
 * em teste e como escape hatch. NUNCA lanca.
 */
function keychainEntryOrNull() {
  if (process.env.AIDVLABS_CREDENTIALS_FILE) return null;
  const mod = loadKeyring();
  if (!mod) return null;
  try {
    return new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return null;
  }
}

/** Parse defensivo de uma credencial serializada; retorna objeto ou null. */
function parseCredential(raw) {
  try {
    const cred = JSON.parse(raw);
    if (!cred || typeof cred !== "object") return null;
    return cred;
  } catch {
    return null;
  }
}

/**
 * Le a credencial { access_jwt, refresh } ou null (ausente/corrompida).
 * Tenta o keychain do SO primeiro; se indisponivel ou sem entrada, cai no
 * arquivo. O override AIDVLABS_CREDENTIALS_FILE forca o caminho de arquivo.
 */
export function readCredential() {
  const entry = keychainEntryOrNull();
  if (entry) {
    try {
      const raw = entry.getPassword();
      if (raw) {
        const cred = parseCredential(raw);
        if (cred) return cred;
      }
    } catch {
      // ausente no keychain (NoEntry) ou erro de runtime -> tenta arquivo
    }
  }
  const path = credentialPath();
  if (!existsSync(path)) return null;
  return parseCredential(readFileSync(path, "utf-8"));
}

/**
 * Grava a credencial. Tenta o keychain do SO primeiro; se indisponivel, cai no
 * arquivo com modo restritivo 0o600 no POSIX (chmod garante a permissao mesmo
 * em sobrescrita). O override AIDVLABS_CREDENTIALS_FILE forca o arquivo.
 * Retorna o destino usado ("keychain" ou o path do arquivo).
 */
export function writeCredential(cred) {
  const json = JSON.stringify(cred, null, 2);
  const entry = keychainEntryOrNull();
  if (entry) {
    try {
      entry.setPassword(json);
      return "keychain";
    } catch {
      // keychain indisponivel em runtime -> cai para arquivo 0600
    }
  }
  const path = credentialPath();
  const posix = process.platform !== "win32";
  mkdirSync(dirname(path), { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
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
 * Decodifica o payload do JWT (base64url do meio) SEM verificar assinatura
 * e retorna o claim `sub` (string) ou null se ausente/nao parseavel.
 * Usado pra derivar o autor da memoria (namespace-por-autor, CMR-138).
 */
export function decodeJwtSub(jwt) {
  try {
    if (typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// --- D7: file-lock para serializar refresh entre processos (MCP + sync) ---

/** Sleep interno (auth.mjs nao tinha um). */
function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Path do lock: irmao do arquivo de credencial. Compartilhado pelos 3 plugins. */
export function lockPath() {
  return join(dirname(credentialPath()), "aidvlabs-mcp.lock");
}

// Um lock so pode ser considerado ABANDONADO depois que um refresh legitimo
// (budget REFRESH_TIMEOUT_MS = 60s via AbortController) ja teria terminado.
// LOCK_STALE_MS/LOCK_MAX_WAIT_MS < REFRESH_TIMEOUT_MS roubava o lock de um
// holder VIVO -> o ladrao fazia SUA propria chamada de rede lendo `current`
// ainda "old" -> rotacao dupla (o exato risco que o D7 previne: rotacao dupla
// pode revogar a family). Por isso 90s (> 60s + margem): so rouba de holder
// genuinamente morto; um holder vivo termina em <60s e LIBERA, entao o waiter
// re-le e REUSA em vez de roubar.
const LOCK_STALE_MS = 90_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 90_000;

/**
 * Adquire lock exclusivo via open('wx'). Grava um TOKEN de posse unico
 * (`${pid}:${Date.now()}`) no arquivo e retorna { fd, token } — o token deixa
 * o release apagar SO o proprio lock (nao o de um novo detentor). Rouba lock
 * stale (mtime > LOCK_STALE_MS = holder morto) e, no fim da janela de espera
 * (LOCK_MAX_WAIT_MS), rouba para nao travar indefinidamente. Todo ramo que NAO
 * adquire dorme LOCK_RETRY_MS antes de retentar -> nunca ha busy-loop. NUNCA
 * promete fairness: so serializa.
 */
async function acquireLock() {
  const path = lockPath();
  const posix = process.platform !== "win32";
  mkdirSync(dirname(path), { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  const token = `${process.pid}:${Date.now()}`;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try { writeFileSync(fd, token); } catch { /* best-effort */ }
      return { fd, token };
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    // EEXIST: outro detentor. Decide roubo (stale OU deadline) e SEMPRE dorme
    // LOCK_RETRY_MS antes de retentar -> nenhum ramo faz spin apertado.
    let steal = false;
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age > LOCK_STALE_MS) steal = true;
    } catch {
      // sumiu entre a falha e o stat: apenas retenta (dorme abaixo)
    }
    if (!steal && Date.now() > deadline) steal = true;
    if (steal) { try { unlinkSync(path); } catch {} }
    await sleepMs(LOCK_RETRY_MS);
  }
}

/**
 * Libera o lock: fecha o fd SEMPRE; e so apaga o arquivo se o conteudo atual
 * ainda for o `token` que ESTE holder gravou. Se o arquivo sumiu ou ja e de
 * outro detentor (ex: foi roubado como stale e recriado), NAO apaga — apagar o
 * lock alheio quebraria a exclusao mutua do novo dono. Leitura best-effort.
 */
function releaseLock(fd, token) {
  try { closeSync(fd); } catch {}
  try {
    if (readFileSync(lockPath(), "utf-8") === token) unlinkSync(lockPath());
  } catch {
    // arquivo ausente/ilegivel: nada a apagar
  }
}

/**
 * Troca o refresh por um novo par (rotacao). POST {APP_BASE}/cli/token/refresh.
 * 2xx -> grava { access_jwt, refresh } e retorna o novo access_jwt.
 * nao-2xx (ex. 401 = refresh revogado) -> lanca mensagem acionavel.
 */
export async function refreshOnce(fetchImpl = fetch) {
  const before = readCredential();
  if (!before || !before.refresh) throw noCredentialError();

  const { fd, token } = await acquireLock();
  try {
    // Re-le SOB o lock: se outro processo ja rotacionou, o access_jwt mudou ->
    // reusa o novo token em vez de rotacionar de novo (rotacao dupla revogaria
    // a family). Compara pelo access_jwt (rotacao sempre o troca).
    const current = readCredential();
    if (current && current.access_jwt && current.access_jwt !== before.access_jwt) {
      return current.access_jwt;
    }
    const refresh = current && current.refresh ? current.refresh : before.refresh;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${APP_BASE}/cli/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
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
    // Defensivo: se a resposta omitir o refresh, preserva o atual.
    writeCredential({ access_jwt: data.access_jwt, refresh: data.refresh ?? refresh });
    return data.access_jwt;
  } finally {
    releaseLock(fd, token);
  }
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

// --- LOGIN: loopback browser + PKCE (RFC 8252 + RFC 7636) ---

/** Tempo maximo aguardando o callback do browser. */
const LOGIN_TIMEOUT_MS = 120_000;

/**
 * code_verifier PKCE: 32 bytes aleatorios -> base64url SEM padding (43 chars,
 * piso do range 43-128 da RFC 7636).
 */
export function genCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * code_challenge S256: base64url(sha256(verifier)) SEM padding. DEVE bater com
 * o servidor (vetor RFC 7636 Appendix B coberto em teste).
 */
export function challengeFromVerifier(verifier) {
  return crypto.createHash("sha256").update(verifier).digest().toString("base64url");
}

/** state anti-CSRF: aleatorio base64url. */
export function genState() {
  return crypto.randomBytes(16).toString("base64url");
}

/** Escapa o minimo para nao quebrar o HTML de resposta no browser. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Abre a URL no browser do sistema (cross-platform). Best-effort: se falhar, o
 * usuario ainda tem a URL impressa no stdout.
 */
export function openBrowser(url, spawnImpl = spawn, platform = process.platform) {
  try {
    let cmd, args;
    if (platform === "win32") {
      // rundll32 (um .exe direto, sem shell) recebe a URL como argumento
      // literal: os `&` da query string NAO sao interpretados. `cmd /c start ""`
      // tratava `&` como separador de comando e truncava a URL no 1o `&`,
      // perdendo redirect_uri/code_challenge/state (era a causa do "invalid
      // authorization request"). Tambem evita o escaping especial que o Node
      // aplica a cmd.exe (CVE-2024-27980). Fallback: a URL ja sai no stdout.
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawnImpl(cmd, args, { detached: true, stdio: "ignore" });
    if (child && typeof child.unref === "function") child.unref();
  } catch {
    // segue: a URL ja foi impressa no stdout como fallback
  }
}

/**
 * Fluxo de login: sobe um servidor loopback EFEMERO em 127.0.0.1, abre o
 * browser na pagina de consentimento do app (APP_BASE/cli/authorize), recebe o
 * callback com o code, troca por { access_jwt, refresh } em /cli/token usando
 * PKCE S256 e grava a credencial. Resolve true em sucesso; rejeita em
 * erro/timeout. Aceita apenas UMA requisicao valida em /callback.
 *
 * Injecoes (teste): fetchImpl (troca de code), openImpl (abrir browser),
 * log (mensagens de progresso), timeoutMs.
 */
export async function loginFlow({
  fetchImpl = fetch,
  openImpl = openBrowser,
  log = (m) => console.log(m),
  timeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  const verifier = genCodeVerifier();
  const challenge = challengeFromVerifier(verifier);
  const state = genState();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let redirectUri = null;

    const shutdown = (after) => {
      if (timer) clearTimeout(timer);
      try {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      } catch {
        // ignore
      }
      server.close(() => after());
    };
    const succeed = (val) => {
      if (settled) return;
      settled = true;
      shutdown(() => resolve(val));
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      shutdown(() => reject(err));
    };

    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("requisicao invalida");
        return;
      }
      // Trata apenas GET /callback; resto e 404 sem encerrar o fluxo.
      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("nao encontrado");
        return;
      }
      const recvState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      // state divergente: 400 e IGNORA (nao encerra) — aceita so o callback valido.
      if (recvState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("state invalido");
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("code ausente");
        return;
      }
      // Callback valido: troca o code pelo par de tokens.
      (async () => {
        try {
          const tokenRes = await fetchImpl(`${APP_BASE}/cli/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
          });
          if (!tokenRes.ok) {
            const body = await tokenRes.text().catch(() => "");
            throw new Error(
              `troca de code falhou (HTTP ${tokenRes.status})${body ? `: ${body}` : ""}`,
            );
          }
          const data = await tokenRes.json();
          if (!data || typeof data.access_jwt !== "string" || !data.access_jwt) {
            throw new Error("resposta de /cli/token sem access_jwt");
          }
          writeCredential({ access_jwt: data.access_jwt, refresh: data.refresh });
          log("Login concluido. Credencial salva.");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
          res.end(
            "<!doctype html><html lang=pt-br><meta charset=utf-8>" +
              "<title>Login concluido</title>" +
              '<body style="font-family:system-ui,sans-serif;padding:2rem">' +
              "<h1>Login concluido</h1><p>Pode fechar esta aba.</p></body></html>",
            () => succeed(true),
          );
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
          res.end(
            "<!doctype html><html lang=pt-br><meta charset=utf-8>" +
              "<title>Falha no login</title>" +
              '<body style="font-family:system-ui,sans-serif;padding:2rem">' +
              `<h1>Falha no login</h1><p>${escapeHtml(e.message)}</p></body></html>`,
            () => fail(e),
          );
        }
      })();
    });

    server.on("error", (err) => fail(err));

    // Porta EFEMERA (0), bind LITERAL 127.0.0.1 (nunca localhost/0.0.0.0).
    // Forma de OBJETO de listen() para passar exclusive:true (a forma posicional
    // listen(0, host, opts) interpretaria o objeto como backlog).
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      if (!port) {
        fail(new Error("nao foi possivel obter a porta do loopback"));
        return;
      }
      // redirect_uri SEM query/fragment e com path EXATO /callback (allowlist
      // estrita do servidor: scheme http, host literal 127.0.0.1, path /callback).
      redirectUri = `http://127.0.0.1:${port}/callback`;

      const authorizeUrl = new URL("/cli/authorize", APP_BASE);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);
      const authUrl = authorizeUrl.toString();

      log("Abrindo o navegador para login...");
      log(`Se o navegador nao abrir, acesse:\n${authUrl}`);
      openImpl(authUrl);
      log("Aguardando autorizacao...");

      timer = setTimeout(() => {
        fail(
          new Error(
            `Tempo esgotado (${Math.round(timeoutMs / 1000)}s) aguardando autorizacao no ` +
              "navegador. Rode o login novamente.",
          ),
        );
      }, timeoutMs);
    });
  });
}
