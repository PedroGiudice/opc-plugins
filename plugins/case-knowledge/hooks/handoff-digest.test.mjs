import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHookOutput, daysSince, fetchHandoff, formatDigest,
  readState, samePath, statePath, writeState,
} from "./handoff-digest.mjs";

// ---------------------------------------------------------------------------
// daysSince

test("daysSince: sem marca -> 7 (default)", () => {
  assert.equal(daysSince(undefined), 7);
  assert.equal(daysSince(null), 7);
  assert.equal(daysSince(""), 7);
  assert.equal(daysSince("nao-e-data"), 7);
});

test("daysSince: marca de 3 dias atras -> 3; arredonda pra cima", () => {
  const now = Date.parse("2026-08-04T12:00:00Z");
  assert.equal(daysSince("2026-08-01T12:00:00Z", now), 3);
  assert.equal(daysSince("2026-08-01T11:00:00Z", now), 4); // 3d1h -> 4
});

test("daysSince: clamp 1..30; marca no futuro -> default", () => {
  const now = Date.parse("2026-08-04T12:00:00Z");
  assert.equal(daysSince("2026-08-04T11:59:00Z", now), 1);
  assert.equal(daysSince("2026-01-01T00:00:00Z", now), 30);
  assert.equal(daysSince("2026-09-01T00:00:00Z", now), 7);
});

// ---------------------------------------------------------------------------
// samePath

test("samePath: NTFS-insensitive em caixa e separador", () => {
  assert.equal(
    samePath("C:\\Users\\Pedro\\cases\\X", "c:/users/pedro/cases/x"),
    true,
  );
  assert.equal(samePath("/home/opc/a", "/home/opc/a/"), true);
  assert.equal(samePath("/home/opc/a", "/home/opc/b"), false);
  assert.equal(samePath(null, "/home/opc/a"), false);
});

// ---------------------------------------------------------------------------
// formatDigest

const SESS_ANA = {
  session_id: "s1",
  repo_path: "C:\\Users\\anabeatriz\\cases\\angatu-priscila",
  first_ts: "2026-07-30T20:00:00Z",
  last_ts: "2026-07-31T16:54:00Z",
  turns: 12,
  opening: "analisar se a reclamante e PCD e o impacto na cota",
};

test("formatDigest: sessao de outra origem vira linha com data, autor e tema", () => {
  const out = formatDigest("angatu-priscila", [SESS_ANA], "C:\\Users\\pedro\\cases\\angatu-priscila");
  assert.match(out, /HANDOFF DO CASO \[angatu-priscila\]/);
  assert.match(out, /- 2026-07-31 anabeatriz \(12 turnos\): analisar se a reclamante e PCD/);
  assert.match(out, /memoria_search/);
});

test("formatDigest: sessao da PROPRIA maquina e filtrada; sem outras -> null", () => {
  const own = { ...SESS_ANA, repo_path: "C:\\Users\\pedro\\cases\\angatu-priscila" };
  assert.equal(
    formatDigest("angatu-priscila", [own], "c:/users/pedro/cases/angatu-priscila"),
    null,
  );
  assert.equal(formatDigest("x", [], "/home/opc/x"), null);
  assert.equal(formatDigest("x", null, "/home/opc/x"), null);
});

test("formatDigest: opening com quebras de linha vira espaco e trunca", () => {
  const s = { ...SESS_ANA, opening: `linha1\nlinha2\t${"x".repeat(300)}` };
  const out = formatDigest("x", [s], "/home/opc/outro");
  assert.match(out, /linha1 linha2/);
  assert.ok(!out.includes("x".repeat(250)));
});

test("formatDigest: origem irreconhecivel ganha rotulo generico", () => {
  const s = { ...SESS_ANA, repo_path: "D:\\estranho\\caso" };
  const out = formatDigest("x", [s], "/home/opc/outro");
  assert.match(out, /origem desconhecida/);
});

// ---------------------------------------------------------------------------
// estado local

test("estado: write/read roundtrip em <cwd>/.claude/handoff-state.json", () => {
  const cwd = mkdtempSync(join(tmpdir(), "handoff-"));
  try {
    assert.deepEqual(readState(cwd), {});
    writeState(cwd, { last_digest_ts: "2026-08-04T10:00:00Z" });
    assert.deepEqual(readState(cwd), { last_digest_ts: "2026-08-04T10:00:00Z" });
    assert.match(readFileSync(statePath(cwd), "utf-8"), /last_digest_ts/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fetchHandoff

test("fetchHandoff: sucesso devolve sessions; manda repo_path e days", async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ status: "ok", sessions: [SESS_ANA], days: 7 }),
    };
  };
  const out = await fetchHandoff("/home/opc/x", 7, fakeFetch, null);
  assert.equal(out.length, 1);
  assert.match(captured.url, /\/handoff$/);
  assert.deepEqual(captured.body, { repo_path: "/home/opc/x", days: 7 });
});

test("fetchHandoff: HTTP nao-ok ou erro -> null (degrade)", async () => {
  assert.equal(await fetchHandoff("/x", 7, async () => ({ ok: false }), null), null);
  assert.equal(
    await fetchHandoff("/x", 7, async () => { throw new Error("rede"); }, null),
    null,
  );
});

// ---------------------------------------------------------------------------
// output do hook

test("buildHookOutput: shape SessionStart", () => {
  const out = buildHookOutput("ctx");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "ctx");
});
