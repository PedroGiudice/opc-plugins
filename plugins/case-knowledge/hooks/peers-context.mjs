#!/usr/bin/env node
/**
 * Hook SessionStart: surfaca a memoria dos peers (colegas) do caso.
 *
 * Le o artefato AGREGADO <caso>/.memoria/PEERS.md, montado pelo sync
 * (buildPeersIndex, ja capeado em 25 KB com trailer visivel). 1 arquivo
 * por sessao — nao anda subdirs de autor nem precisa saber quem e o self
 * (o hook nao tem credencial). READ-ONLY: NUNCA toca o CLAUDE.md do caso.
 *
 * Gate por pasta de caso reusa caseSlugFromCwd() do memoria-context (mesma
 * deteccao alinhada ao detectCase() do server.mjs). Degrada gracioso ({}
 * em QUALQUER falha — fora de caso, arquivo ausente/vazio, erro de leitura
 * ou stdin invalido) — nunca quebra o Claude Code.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { caseSlugFromCwd, defaultCasesBase } from "./memoria-context.mjs";

const CASES_BASE = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();

const PREFIXO =
  "[memoria-peers] Memoria dos colegas neste caso (sincronizada; leitura — nao editar):\n";

/**
 * Le <caso>/.memoria/PEERS.md. Retorna o conteudo quando nao-vazio
 * (apos trim); null quando ausente, vazio/whitespace, ou erro de leitura.
 */
export function readPeersFile(caseDir, readImpl = readFileSync) {
  if (!caseDir) return null;
  try {
    const content = readImpl(join(caseDir, ".memoria", "PEERS.md"), "utf-8");
    return content && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Embrulha o conteudo no shape do SessionStart, com o prefixo fixo. */
export function buildHookOutput(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: PREFIXO + context,
    },
  };
}

/**
 * Resolve o output do hook para um cwd. Retorna o objeto do SessionStart
 * quando o cwd e pasta de caso E ha PEERS.md nao-vazio; caso contrario {}.
 * Comparacao de path string-based (via caseSlugFromCwd) — sem realpath aqui
 * (o main() canonicaliza symlinks antes de chamar). Testavel sem stdin.
 */
export function resolvePeersOutput(cwd, base = CASES_BASE) {
  const slug = caseSlugFromCwd(cwd, base);
  if (!slug) return {};
  const content = readPeersFile(join(base, slug));
  if (!content) return {};
  return buildHookOutput(content);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    /* stdin invalido -> segue com {} */
  }
  const rawCwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  // Canonicaliza symlinks nos DOIS lados (na VM cases/ -> tenants/1/cases;
  // getcwd retorna path FISICO). Path inexistente cai no valor original.
  const physical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const out = resolvePeersOutput(physical(rawCwd), physical(CASES_BASE));
  console.log(JSON.stringify(out));
}

// So roda main quando invocado como script (permite import nos testes).
// pathToFileURL e obrigatorio: comparacao com `file://${argv[1]}` falha no
// Windows por causa do drive letter (file:///C:/...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => console.log("{}"));
}
