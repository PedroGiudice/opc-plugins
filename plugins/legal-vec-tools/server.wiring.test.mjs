import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "server.mjs"), "utf-8");

test("server.mjs importa requestWithAuth e loginFlow de ./auth.mjs", () => {
  assert.match(
    src,
    /import\s*\{[^}]*\brequestWithAuth\b[^}]*\bloginFlow\b[^}]*\}\s*from\s*["']\.\/auth\.mjs["']/s,
  );
});

test("apiPost/apiGet injetam authHeaders via requestWithAuth", () => {
  assert.match(src, /requestWithAuth\(\s*\(authHeaders\)\s*=>/);
  assert.match(src, /\.\.\.authHeaders/);
});

test("subcomando login guardado por process.argv[2] === 'login'", () => {
  assert.match(src, /process\.argv\[2\]\s*===\s*["']login["']/);
  assert.match(src, /await\s+loginFlow\(\)/);
});
