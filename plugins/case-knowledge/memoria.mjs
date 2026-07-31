/**
 * memoria_search: busca na memoria de sessoes do caso (legal-cogmem :3940).
 * Mesmo endpoint default do hook memoria-context.mjs; override via
 * LEGAL_COGMEM_API_BASE.
 */

import { requestWithAuth } from "./auth.mjs";

export const MEM_API_BASE =
  process.env.LEGAL_COGMEM_API_BASE || "http://100.123.73.128:3940/api";

export function formatMemoriaResults(chunks) {
  if (!chunks || chunks.length === 0) {
    return "nenhuma memoria registrada neste caso ainda.";
  }
  return chunks
    .map((c) => {
      const score = typeof c.score === "number" ? c.score.toFixed(2) : "?";
      const ts = c.timestamp ?? "?";
      const sess = c.session_id ?? "?";
      return `[${score}] (${ts}, sessao ${sess})\n${c.content ?? ""}`;
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
