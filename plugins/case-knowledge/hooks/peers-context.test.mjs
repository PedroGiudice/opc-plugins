import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePeersOutput,
  readPeersFile,
  buildHookOutput,
} from "./peers-context.mjs";

// Monta uma base temporaria com um caso `meu-caso` e (opcionalmente) o
// artefato agregado <caso>/.memoria/PEERS.md. content===null => sem arquivo.
function setupCase(content) {
  const base = mkdtempSync(join(tmpdir(), "peers-base-"));
  const caseDir = join(base, "meu-caso");
  mkdirSync(join(caseDir, ".memoria"), { recursive: true });
  if (content !== null)
    writeFileSync(join(caseDir, ".memoria", "PEERS.md"), content);
  return { base, caseDir };
}

test("resolvePeersOutput: cwd de caso com PEERS.md -> additionalContext com conteudo e prefixo", () => {
  const { base, caseDir } = setupCase(
    "## peer-ana\n\nDecidiu X sobre prescricao.\n",
  );
  try {
    const out = resolvePeersOutput(caseDir, base);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes(
        "Decidiu X sobre prescricao",
      ),
    );
    assert.ok(
      out.hookSpecificOutput.additionalContext.startsWith("[memoria-peers]"),
    );
    // subdir do caso (ex.: base/) tambem ativa o gate
    const outSub = resolvePeersOutput(join(caseDir, "base"), base);
    assert.ok(outSub.hookSpecificOutput.additionalContext.includes("Decidiu X"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolvePeersOutput: cwd fora da base canonica -> {}", () => {
  const { base } = setupCase("conteudo qualquer");
  try {
    assert.deepEqual(resolvePeersOutput("/tmp/qualquer/outro", base), {});
    // a raiz da base nao e um caso
    assert.deepEqual(resolvePeersOutput(base, base), {});
    assert.deepEqual(resolvePeersOutput("", base), {});
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolvePeersOutput: caso sem PEERS.md -> {}", () => {
  const { base, caseDir } = setupCase(null); // .memoria existe, PEERS.md ausente
  try {
    assert.deepEqual(resolvePeersOutput(caseDir, base), {});
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolvePeersOutput: PEERS.md vazio/whitespace -> {}", () => {
  const { base, caseDir } = setupCase("   \n\t\n");
  try {
    assert.deepEqual(resolvePeersOutput(caseDir, base), {});
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPeersFile: le PEERS.md; null quando ausente", () => {
  const { base, caseDir } = setupCase("linha util\n");
  try {
    assert.ok(readPeersFile(caseDir).includes("linha util"));
    assert.equal(readPeersFile(join(base, "inexistente")), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildHookOutput: shape SessionStart com prefixo fixo de leitura", () => {
  const o = buildHookOutput("CORPO");
  assert.equal(o.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(o.hookSpecificOutput.additionalContext.endsWith("CORPO"));
  assert.ok(o.hookSpecificOutput.additionalContext.includes("nao editar"));
});
