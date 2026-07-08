#!/usr/bin/env node
/**
 * setup.mjs — onboarding em UM comando (CMR-116).
 *
 * Monta uma maquina cliente nova do Claude Code juridico de ponta a ponta:
 *   1. npm install no plugin do marketplace clone (deps do MCP/keychain)
 *   2. login unico das 3 bases (browser + PKCE) se nao ha credencial
 *   3. pasta de casos (~/cases)
 *   4. scaffolding via GET {API}/scaffolding (nunca sobrescreve arquivo local)
 *   5. env vars das 3 APIs publicas (setx, Windows)
 *   6. scheduled task do espelho de casos (CaseKnowledge-SyncCases) + 1o sync
 *
 * REGRA DURA: este arquivo e STANDALONE — zero imports de pacotes npm no
 * top-level (so builtins do Node; fetch e global no Node 18+). E isso que
 * quebra o ovo-galinha: o server.mjs importa o SDK MCP no top-level e explode
 * com ERR_MODULE_NOT_FOUND em maquina nova sem npm install previo. O auth.mjs
 * so usa builtins no top-level, entao e importado DINAMICAMENTE no passo 2,
 * depois que o passo 1 garantiu o node_modules (keychain @napi-rs/keyring).
 *
 * Uso documentado (funciona sem deps instaladas):
 *   node "$HOME\.claude\plugins\marketplaces\opc-plugins\plugins\case-knowledge\setup.mjs"
 *
 * Saida ASCII de proposito (sem acentos): consoles Windows com codepage OEM
 * exibem mojibake em UTF-8 acentuado — mesma convencao do auth.mjs.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const IS_WIN = process.platform === "win32";
const TASK_NAME = "CaseKnowledge-SyncCases";

/** Espelha os defaults por plataforma do server.mjs/sync-cases.mjs. */
export function defaultApiBase() {
  if (IS_WIN) return "https://api.aidvlabs.com/api";
  return "http://127.0.0.1:8422/api";
}

/** Pasta de casos do cliente. Na VM o server usa case-docs/cases, mas o
 * setup e ferramenta de maquina CLIENTE — ~/cases nos dois SOs. */
export function defaultCasesBase() {
  if (IS_WIN) return join(process.env.USERPROFILE || os.homedir(), "cases");
  return join(os.homedir(), "cases");
}

/** As 3 env vars persistidas no passo 5 (APIs publicas com Bearer). */
export const SETUP_ENV_VARS = [
  ["CASE_KNOWLEDGE_API_BASE", "https://api.aidvlabs.com/api"],
  ["STJ_VEC_API_BASE", "https://stj.aidvlabs.com/api"],
  ["LEGAL_VEC_API_BASE", "https://legalvec.aidvlabs.com/api"],
];

/**
 * Diretorio do plugin no MARKETPLACE CLONE — estavel entre versoes do plugin
 * (o cache install do CC e versionado e trocado a cada update; a scheduled
 * task e o npm install DEVEM mirar o clone). Fallback: o diretorio deste
 * proprio arquivo (cobre marketplace em root nao-padrao).
 */
export function resolvePluginDir(homedir = os.homedir()) {
  const marketplace = join(
    homedir, ".claude", "plugins", "marketplaces", "opc-plugins",
    "plugins", "case-knowledge",
  );
  if (existsSync(join(marketplace, "auth.mjs"))) return marketplace;
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Path relativo seguro vindo do manifest de scaffolding: segmentos separados
 * por `/`, sem `..`/`.`/vazio, sem `\`, sem raiz absoluta nem drive letter.
 * Defesa client-side contra um manifest malicioso/corrompido escrever fora
 * da pasta de casos.
 */
export function isSafeScaffoldingPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (p.includes("\\") || p.includes("\0")) return false;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/**
 * Decide o que fazer com cada arquivo do manifest: escrever (nao existe
 * localmente), pular (ja existe — igual OU editado, NUNCA sobrescreve;
 * mesmo principio do CMR-103) ou rejeitar (path inseguro/entrada invalida).
 * Pura: existsFn injetavel para teste.
 */
export function planScaffoldingWrites(files, existsFn) {
  const plan = { write: [], skip: [], invalid: [] };
  for (const f of files || []) {
    if (!f || !isSafeScaffoldingPath(f.path) || typeof f.content !== "string") {
      plan.invalid.push(f && typeof f.path === "string" ? f.path : "(entrada invalida)");
      continue;
    }
    if (existsFn(f.path)) plan.skip.push(f);
    else plan.write.push(f);
  }
  return plan;
}

/** String single-quoted de PowerShell (escapa ' dobrando). */
export function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Comando PowerShell inline que registra a scheduled task do espelho,
 * replicando legal-scaffolding/scripts/Install-SyncTask.ps1: trigger AtLogOn
 * com Repetition herdada de um TimeTrigger descartavel de 15 min e
 * Duration='' (repetir indefinidamente — [TimeSpan]::MaxValue e rejeitado
 * pelo Task Scheduler). Termina disparando o primeiro sync.
 */
export function buildSyncTaskCommand(scriptPath) {
  return [
    "$ErrorActionPreference='Stop'",
    "$node=(Get-Command node -ErrorAction Stop).Source",
    `$script=${psSingleQuote(scriptPath)}`,
    "if (-not (Test-Path $script)) { throw ('sync-cases.mjs nao encontrado: ' + $script) }",
    "$action=New-ScheduledTaskAction -Execute $node -Argument ('\"'+$script+'\"')",
    "$logon=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$timer=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)",
    "$logon.Repetition=$timer.Repetition",
    "$logon.Repetition.Duration=''",
    "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew",
    `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $logon -Settings $settings -Description 'Espelho de casos VM->local (case-knowledge)' | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
  ].join("; ");
}

// ---------- passos (I/O) ----------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n[FALHA] ${msg}\n`);
  process.exit(1);
}

/** Passo 1: garante node_modules no plugin do marketplace clone. */
function ensureDeps(pluginDir) {
  log(`[1/6] Dependencias do plugin (${pluginDir})`);
  if (existsSync(join(pluginDir, "node_modules"))) {
    log("      node_modules presente — pulando npm install.");
    return;
  }
  log("      Rodando npm install (primeira vez pode demorar um pouco)...");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: pluginDir,
    stdio: "inherit",
    // Windows: npm e npm.cmd — precisa de shell (Node bloqueia spawn direto
    // de .cmd sem shell desde o patch do CVE-2024-27980).
    shell: IS_WIN,
  });
  if (r.error || r.status !== 0) {
    fail(
      `npm install falhou em ${pluginDir}` +
        (r.error ? ` (${r.error.message})` : ` (exit ${r.status})`) +
        ". Verifique se o Node.js LTS esta instalado e rode o setup de novo.",
    );
  }
  log("      npm install concluido.");
}

/** Passo 2: credencial do keychain aidvlabs-mcp; login se ausente. */
async function ensureCredential(auth) {
  log("[2/6] Credencial (login unico das 3 bases)");
  const cred = auth.readCredential();
  if (cred && cred.access_jwt && cred.refresh) {
    log("      Credencial existente encontrada — pulando login.");
    return;
  }
  log("      Sem credencial. Abrindo o navegador para login...");
  await auth.loginFlow();
}

/** Passo 4: baixa o scaffolding e escreve so o que nao existe localmente. */
async function applyScaffolding(auth, apiBase, casesBase) {
  log("[4/6] Scaffolding da pasta de casos");
  const doFetch = () =>
    auth.requestWithAuth((authHeaders) =>
      fetch(`${apiBase}/scaffolding`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(60_000),
      }),
    );

  let res;
  try {
    res = await doFetch();
  } catch (err) {
    // 401 esgotado (refresh morto): uma chance de relogar e repetir.
    if (err && /401/.test(String(err.message))) {
      log("      Sessao expirada. Abrindo o navegador para login...");
      await auth.loginFlow();
      res = await doFetch();
    } else {
      throw err;
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /scaffolding retornou HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const manifest = await res.json();

  const plan = planScaffoldingWrites(manifest.files, (rel) =>
    existsSync(join(casesBase, ...rel.split("/"))),
  );
  for (const f of plan.write) {
    const dest = join(casesBase, ...f.path.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, "utf-8");
  }
  log(`      Versao do scaffolding: ${manifest.version || "(sem version)"}`);
  log(`      Escritos: ${plan.write.length} arquivo(s).`);
  if (plan.skip.length > 0) {
    log(`      Preservados (ja existiam, NAO sobrescritos): ${plan.skip.length}`);
    for (const f of plan.skip) log(`        - ${f.path}`);
  }
  for (const p of plan.invalid) log(`      [aviso] entrada invalida ignorada: ${p}`);
  return plan;
}

/** Passo 5: persiste as env vars das 3 APIs (setx no Windows). */
function applyEnvVars(failures) {
  log("[5/6] Variaveis de ambiente das 3 APIs");
  if (!IS_WIN) {
    log("      Fora do Windows: adicione ao seu shell profile, se necessario:");
    for (const [k, v] of SETUP_ENV_VARS) log(`        export ${k}="${v}"`);
    return;
  }
  for (const [k, v] of SETUP_ENV_VARS) {
    const r = spawnSync("setx", [k, v], { stdio: "pipe" });
    if (r.error || r.status !== 0) {
      failures.push(`setx ${k} falhou — rode manualmente: setx ${k} "${v}"`);
    } else {
      log(`      setx ${k} ok`);
    }
  }
  log("      (valem para NOVOS terminais/sessoes; feche e reabra o terminal)");
}

/** Passo 6: registra a scheduled task do espelho e dispara o primeiro sync. */
function installSyncTask(pluginDir, failures) {
  log(`[6/6] Sincronizador de casos (tarefa '${TASK_NAME}')`);
  if (!IS_WIN) {
    log("      Fora do Windows: passo pulado (espelho de casos e do cliente Windows).");
    return;
  }
  const syncScript = join(pluginDir, "sync-cases.mjs");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", buildSyncTaskCommand(syncScript)],
    { stdio: "inherit" },
  );
  if (r.error || r.status !== 0) {
    failures.push(
      `registro da tarefa '${TASK_NAME}' falhou — rode legal-scaffolding: ` +
        "scripts/Install-SyncTask.ps1 manualmente (esta na sua pasta de casos).",
    );
    return;
  }
  log("      Tarefa registrada (logon + 15 min) e primeiro sync disparado.");
}

/**
 * Verificacao extra (best-effort, nao instala nada): os geradores de peca
 * .docx da skill gerar-peca-cmr (plugin legal-team) exigem Python +
 * python-docx. Falta vira pendencia no resumo com o comando pronto.
 */
function checkPecaGenerators(failures) {
  log("[extra] Geradores de peca (.docx): Python + python-docx");
  const candidates = IS_WIN ? ["python", "py"] : ["python3", "python"];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-c", "import docx"], { stdio: "pipe" });
    if (!r.error && r.status === 0) {
      log(`      ok (${bin} com python-docx presente).`);
      return;
    }
    if (!r.error) {
      // interpretador existe, falta o pacote
      failures.push(
        "python-docx ausente (geradores de peca nao rodam) — instale: " +
          `${bin} -m pip install python-docx`,
      );
      return;
    }
  }
  failures.push(
    "Python nao encontrado (geradores de peca nao rodam) — instale: " +
      "winget install Python.Python.3.13, reabra o terminal e rode: pip install python-docx",
  );
}

async function main() {
  log("=== Setup do Claude Code juridico (aidvlabs) ===");
  const pluginDir = resolvePluginDir();
  const apiBase = process.env.CASE_KNOWLEDGE_API_BASE || defaultApiBase();
  const casesBase = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();

  // 1. Deps ANTES de qualquer import dinamico (keychain nativo do auth.mjs).
  ensureDeps(pluginDir);

  // 2. Import dinamico DEPOIS do npm install — auth.mjs so usa builtins no
  //    top-level, mas o keychain (@napi-rs/keyring) e resolvido lazy a partir
  //    do proprio auth.mjs, entao importamos o do pluginDir.
  const auth = await import(pathToFileURL(join(pluginDir, "auth.mjs")).href);
  try {
    await ensureCredential(auth);
  } catch (err) {
    fail(`login falhou: ${err && err.message ? err.message : String(err)}`);
  }

  // 3. Pasta de casos.
  log(`[3/6] Pasta de casos (${casesBase})`);
  if (existsSync(casesBase)) {
    log("      Ja existe — mantida.");
  } else {
    mkdirSync(casesBase, { recursive: true });
    log("      Criada.");
  }

  // 4. Scaffolding (nunca sobrescreve arquivo local).
  try {
    await applyScaffolding(auth, apiBase, casesBase);
  } catch (err) {
    fail(`scaffolding falhou: ${err && err.message ? err.message : String(err)}`);
  }

  // 5, 6 e extra sao best-effort: falha vira pendencia listada no resumo.
  const failures = [];
  applyEnvVars(failures);
  installSyncTask(pluginDir, failures);
  checkPecaGenerators(failures);

  log("");
  log("=== Resumo ===");
  log(`Pasta de casos: ${casesBase}`);
  log(`API: ${apiBase}`);
  if (failures.length > 0) {
    log("Pendencias (resolver manualmente):");
    for (const f of failures) log(`  - ${f}`);
  } else {
    log("Tudo concluido sem pendencias.");
  }
  log("");
  log("Proximos passos:");
  log("  1. Aguarde o primeiro sync popular os casos (ou rode agora:");
  log(`     node "${join(pluginDir, "sync-cases.mjs")}")`);
  log("  2. Abra uma sessao do Claude Code DENTRO de um caso:");
  log(`     cd ${join(casesBase, "<caso>")} ; claude`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

// Guard de execucao direta (mesmo padrao do sync-cases.mjs): permite importar
// os helpers puros em teste sem disparar o fluxo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    fail(err && err.message ? err.message : String(err));
  });
}
