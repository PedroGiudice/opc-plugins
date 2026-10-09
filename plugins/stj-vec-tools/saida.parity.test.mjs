import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * saida.mjs e uma copia byte-identica em stj-vec-tools (canonico) e
 * legal-vec-tools: import entre plugins quebra no cache install do Claude Code
 * (cada plugin instalado isolado). So roda no dev clone, onde os dois dirs
 * coexistem; no cache install isolado, skip.
 */
const here = import.meta.dirname;
const irmao = join(here, "..", "legal-vec-tools");

test(
  "saida.mjs byte-identico em stj-vec-tools e legal-vec-tools",
  { skip: existsSync(irmao) ? false : "nao e o dev clone (cache install isolado)" },
  () => {
    const canonico = readFileSync(join(here, "saida.mjs"));
    const copia = readFileSync(join(irmao, "saida.mjs"));
    assert.ok(canonico.equals(copia), "saida.mjs divergente em legal-vec-tools");
  },
);
