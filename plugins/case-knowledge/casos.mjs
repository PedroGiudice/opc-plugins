/**
 * Conjunto de casos de UMA sessao (CMR-234). Regra pura, sem MCP nem I/O.
 *
 * Vocabulario (spec 2026-09-04):
 * - principal: caso do cwd; sem ele, o primeiro root que e caso.
 * - adicionados: casos dos roots (pastas que o usuario adicionou), menos o
 *   principal, na ordem dos roots.
 * - ativos: principal + adicionados (escopo default do search).
 * - relacionados: casos_relacionados do case.yaml do principal (agrupamento
 *   permanente, sem clique).
 * - permitidos: ativos + relacionados (tudo que uma tool pode receber em
 *   `caso`/`casos`). Fora disso e erro — o modelo nao escolhe caso por string.
 */
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

const { resolve, join, sep } = nodePath;

/** Path com drive letter Windows (separador nativo ou `/`). */
const WIN_DRIVE = /^[a-z]:(\\|\/|$)/i;

/**
 * Modulo de path a usar: `win32` quando o input e claramente estilo Windows
 * (drive letter), senao o modulo nativo do processo (posix na VM/Linux, win32
 * no cliente Windows). Sem isso, `node:path` padrao (posix aqui na VM) trata
 * "c:\Users\..." como caminho RELATIVO e prefixa com o cwd, corrompendo a
 * deteccao — desvio descoberto rodando a suite nesta VM (CMR-234, Task 5).
 */
function pathModuloPara(path, base) {
  return WIN_DRIVE.test(path) || WIN_DRIVE.test(base) ? nodePath.win32 : nodePath;
}

/**
 * Caso a que um path pertence, ou null. `realpath` canonicaliza symlinks nos
 * DOIS lados (na VM `cases/` e symlink para `tenants/1/cases`). NTFS e
 * case-insensitive: com drive letter nos dois paths a comparacao e em
 * lowercase; o nome do caso preserva a caixa original.
 */
export function caseFromPath(path, base, { realpath = (p) => p } = {}) {
  if (!path || !base) return null;
  const mod = pathModuloPara(path, base);
  const p = realpath(mod.resolve(path));
  const b = realpath(mod.resolve(base));
  const insensitive = WIN_DRIVE.test(p) && WIN_DRIVE.test(b);
  const pF = insensitive ? p.toLowerCase() : p;
  const bF = insensitive ? b.toLowerCase() : b;
  if (!pF.startsWith(bF + mod.sep) && pF !== bF) return null;
  const relative = p.slice(b.length + 1);
  const name = relative.split(mod.sep)[0];
  if (!name) return null;
  return { name, dir: mod.join(b, name) };
}

/** Roots MCP (`[{uri}]`) -> casos, sem duplicatas, na ordem dos roots. */
export function casesFromRoots(roots, base, opts = {}) {
  const out = [];
  const vistos = new Set();
  for (const r of roots || []) {
    const uri = r && typeof r.uri === "string" ? r.uri : "";
    if (!uri.startsWith("file://")) continue;
    let p;
    try {
      p = fileURLToPath(uri);
    } catch {
      continue;
    }
    const c = caseFromPath(p, base, opts);
    if (!c || vistos.has(c.name)) continue;
    vistos.add(c.name);
    out.push(c);
  }
  return out;
}

const SEM_CASO = "Sessao nao esta dentro de um caso. Navegue para cases/<nome> ou adicione a pasta do caso a sessao.";

/**
 * Monta o conjunto da sessao. `relacionados` e a lista de NOMES vinda do
 * case.yaml do principal (dir derivado de `base`).
 */
export function buildSessionCases({ cwdCase = null, rootCases = [], relacionados = [], base }) {
  const primary = cwdCase ?? rootCases[0] ?? null;
  const adicionados = rootCases.filter((c) => !primary || c.name !== primary.name);
  const ativosNomes = new Set((primary ? [primary] : []).concat(adicionados).map((c) => c.name));
  const rel = [];
  for (const nome of relacionados || []) {
    if (typeof nome !== "string" || !nome || ativosNomes.has(nome) || rel.some((c) => c.name === nome)) continue;
    rel.push({ name: nome, dir: base ? join(base, nome) : nome });
  }

  const ativos = () => (primary ? [primary, ...adicionados] : []);
  const permitidos = () => ativos().concat(rel);
  const porNome = (nome) => permitidos().find((c) => c.name === nome) ?? null;

  function resolve(nome) {
    if (!primary) throw new Error(SEM_CASO);
    if (nome === undefined || nome === null || nome === "") return primary;
    const c = porNome(nome);
    if (!c) {
      throw new Error(
        `Caso nao permitido nesta sessao: ${nome}. Permitidos: ${permitidos().map((c) => c.name).join(", ")}`
      );
    }
    return c;
  }

  function escopo(casos) {
    if (!primary) throw new Error(SEM_CASO);
    if (!casos || casos.length === 0) return ativos();
    const out = [];
    for (const item of casos) {
      const lote = item === "relacionados" ? rel : [resolve(item)];
      for (const c of lote) if (!out.some((o) => o.name === c.name)) out.push(c);
    }
    // 'relacionados' num caso sem relacionados expande para nada: erro
    // explicito em vez de lista vazia (que estouraria em quem le alvo[0]).
    if (out.length === 0) {
      throw new Error(
        `Nenhum caso no escopo pedido: ${casos.join(", ")}. ` +
          `Este caso nao tem relacionados no case.yaml. ` +
          `Permitidos: ${permitidos().map((c) => c.name).join(", ")}`
      );
    }
    return out;
  }

  return { primary, adicionados, relacionados: rel, ativos, permitidos, resolve, escopo };
}
