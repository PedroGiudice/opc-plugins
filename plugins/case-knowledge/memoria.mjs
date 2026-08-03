/**
 * memoria_search: busca na memoria de sessoes do caso (legal-cogmem :3940).
 * Mesmo endpoint default do hook memoria-context.mjs; override via
 * LEGAL_COGMEM_API_BASE.
 */

import { requestWithAuth } from "./auth.mjs";

/**
 * Base default do legal-cogmem por PLATAFORMA (CMR-135 Task 6b).
 *
 * Windows (maquina cliente, fora da tailnet) -> URL PUBLICA
 * `https://cogmem.aidvlabs.com/api` (tunnel Cloudflare fail-closed, so
 * /api/context, /api/search, /api/ingest-transcript e /api/health passam).
 * Unix (VM) -> tailnet/loopback direto, sem sair pela borda.
 *
 * `LEGAL_COGMEM_API_BASE` e SOBERANA em qualquer plataforma.
 *
 * Duplicada de proposito em hooks/memoria-context.mjs: o hook nao pode
 * importar a tool (mudou aqui, mudar la).
 */
export function defaultMemApiBase(platform = process.platform) {
  if (platform === "win32") return "https://cogmem.aidvlabs.com/api";
  return "http://100.123.73.128:3940/api";
}

export const MEM_API_BASE =
  process.env.LEGAL_COGMEM_API_BASE || defaultMemApiBase();

/**
 * Rotulo de origem de um chunk a partir do repo_path da maquina que gravou
 * (CMR-154). A memoria do caso e compartilhada pelo tenant; sem isto os
 * trechos chegam anonimos e o modelo nao consegue citar quem disse o que.
 * `C:\Users\<user>\...` -> user; `/home/...` -> "vm"; resto -> null.
 */
export function originLabel(repoPath) {
  if (typeof repoPath !== "string" || !repoPath) return null;
  const win = repoPath.match(/^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)[\\/]/);
  if (win) return win[1];
  if (repoPath.startsWith("/home/")) return "vm";
  return null;
}

export function formatMemoriaResults(chunks) {
  if (!chunks || chunks.length === 0) {
    return "nenhuma memoria registrada neste caso ainda.";
  }
  return chunks
    .map((c) => {
      const score = typeof c.score === "number" ? c.score.toFixed(2) : "?";
      const ts = c.timestamp ?? "?";
      const sess = c.session_id ?? "?";
      const origem = originLabel(c.repo_path);
      const quem = origem ? `${origem}, ` : "";
      return `[${score}] (${quem}${ts}, sessao ${sess})\n${c.content ?? ""}`;
    })
    .join("\n\n---\n\n");
}

export async function memoriaSearch(params, caseInfo, fetchImpl = fetch) {
  const body = {
    query: params.query,
    repo_path: caseInfo.dir,
    limit: params.limit ?? 5,
    days: params.days ?? 30,
  };
  if (params.threshold !== undefined) body.threshold = params.threshold;
  try {
    // requestWithAuth injeta o Bearer quando ha credencial (mesmo login dos
    // demais MCPs, keychain aidvlabs-mcp), refresca proativo (<60s) e reativo
    // (401 -> refresh -> 1 retry). SEM credencial segue SEM Bearer — preserva
    // o uso tailnet enquanto o daemon aceita fallback. Erro de auth cai no
    // catch abaixo e vira "memoria indisponivel: ..."; a tool nunca lanca.
    const res = await requestWithAuth((authHeaders) =>
      fetchImpl(`${MEM_API_BASE}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `memoria indisponivel: HTTP ${res.status} ${text}`.trim();
    }
    const json = await res.json();
    if (json.status !== "ok") {
      return `memoria indisponivel: ${json.message ?? "erro desconhecido"}`;
    }
    return formatMemoriaResults(json.chunks);
  } catch (err) {
    return `memoria indisponivel: ${err.message}`;
  }
}
