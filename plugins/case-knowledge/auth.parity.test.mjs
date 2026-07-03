import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Estrategia (b): auth.mjs e uma copia byte-identica nos 3 plugins (case-knowledge
 * canonico, stj-vec-tools, legal-vec-tools). Import cross-plugin por path relativo
 * quebra no cache install do Claude Code (cada plugin instalado isolado), entao a
 * unica garantia contra divergencia e este teste de paridade.
 *
 * So roda no DEV CLONE (onde os 3 dirs irmaos coexistem). No cache install isolado
 * os dirs irmaos nao existem -> skip.
 */
const here = import.meta.dirname;
const siblings = [
  join(here, "..", "stj-vec-tools"),
  join(here, "..", "legal-vec-tools"),
];
const isDevClone = siblings.every((d) => existsSync(d));

test(
  "auth.mjs byte-identico nos 3 plugins (paridade da copia compartilhada)",
  { skip: isDevClone ? false : "nao e o dev clone (cache install isolado)" },
  () => {
    const canonical = readFileSync(join(here, "auth.mjs"));
    for (const d of siblings) {
      const copy = readFileSync(join(d, "auth.mjs"));
      assert.ok(canonical.equals(copy), `auth.mjs divergente em ${d}`);
    }
  },
);
