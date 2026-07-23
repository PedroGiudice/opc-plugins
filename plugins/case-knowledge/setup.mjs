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
 *   extra: autoUpdate do marketplace opc-plugins (releases chegam sozinhos)
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

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, copyFileSync } from "node:fs";
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

/**
 * Output style default de TODA sessao. cmr-002 e as maquinas dos colegas sao
 * de TRABALHO, nao de dev: as sessoes do CC nelas tem proposito juridico e os
 * colegas sequer codam. Por isso o setup grava outputStyle no settings.json
 * GLOBAL do usuario — sessoes abertas FORA de um caso ja nascem nesse style.
 * O settings.local.json por-caso continua sobrepondo (override societario etc.)
 * pela precedencia do CC (project local > user global).
 */
export const DEFAULT_OUTPUT_STYLE = "Legal Main Agent";

/**
 * Conteudo do ~/.claude/settings.json global com outputStyle setado,
 * preservando as demais chaves do usuario. Pura.
 *   - existingRaw null/vazio -> objeto novo { outputStyle }
 *   - JSON de objeto valido  -> merge (outputStyle sobrescrito)
 *   - JSON invalido/array/null/primitivo -> null (NAO pisa em config alheia;
 *     o caller reporta como pendencia)
 * Retorna { json, changed } ou null. `changed` distingue no-op (ja setado) de
 * alteracao, para o passo de I/O evitar reescrita desnecessaria.
 */
export function buildGlobalSettings(existingRaw, style = DEFAULT_OUTPUT_STYLE) {
  let obj = {};
  if (existingRaw && existingRaw.trim()) {
    try {
      obj = JSON.parse(existingRaw);
    } catch {
      return null;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  }
  const changed = obj.outputStyle !== style;
  obj.outputStyle = style;
  return { json: `${JSON.stringify(obj, null, 2)}\n`, changed };
}

/** String single-quoted de PowerShell (escapa ' dobrando). */
export function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Comando PowerShell inline que registra a scheduled task do espelho,
 * replicando legal-scaffolding/scripts/Install-SyncTask.ps1.
 *
 * Dois triggers (CMR-126): AtLogOn (sync imediato ao logar) + um TimeTrigger
 * Once que arma a repeticao NO REGISTRO — um trigger AtLogOn-only so rearma
 * no proximo logon, entao qualquer re-registro (re-setup/update) sem relogon
 * deixava o sync morto silenciosamente (NextRunTime vazio). Duration=''
 * (repetir indefinidamente — [TimeSpan]::MaxValue e rejeitado pelo Task
 * Scheduler). Repetition NAO e compartilhado entre os triggers (objeto CIM
 * por referencia) — cada um recebe o seu.
 *
 * Action via wscript + sync-cases-hidden.vbs: node.exe direto em sessao
 * interativa abre janela de console a cada sync; o wrapper roda oculto.
 * Termina disparando o primeiro sync.
 */
export function buildSyncTaskCommand(scriptPath) {
  return [
    "$ErrorActionPreference='Stop'",
    "$node=(Get-Command node -ErrorAction Stop).Source",
    `$script=${psSingleQuote(scriptPath)}`,
    "if (-not (Test-Path $script)) { throw ('sync-cases.mjs nao encontrado: ' + $script) }",
    "$vbs=Join-Path (Split-Path $script) 'sync-cases-hidden.vbs'",
    "if (-not (Test-Path $vbs)) { throw ('sync-cases-hidden.vbs nao encontrado (marketplace desatualizado? git pull): ' + $vbs) }",
    "$wscript=Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    "$action=New-ScheduledTaskAction -Execute $wscript -Argument ('\"'+$vbs+'\" \"'+$node+'\" \"'+$script+'\"')",
    "$timer=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)",
    "$timer.Repetition.Duration=''",
    "$logon=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$rep=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)",
    "$logon.Repetition=$rep.Repetition",
    "$logon.Repetition.Duration=''",
    "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew",
    `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger @($logon,$timer) -Settings $settings -Description 'Espelho de casos VM->local (case-knowledge)' | Out-Null`,
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
  log("      Tarefa registrada (a cada 5 min + logon, sem janela) e primeiro sync disparado.");
}

/**
 * Escrita atomica: escreve num tmp no MESMO diretorio e faz rename (atomico no
 * destino). Um crash no meio do writeFileSync deixa so o tmp orfao — o
 * settings.json nunca fica meio-escrito/truncado. Mesmo padrao do sync-cases.mjs.
 */
function writeAtomic(path, content) {
  const tmp = `${path}.setup-tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

/**
 * Passo extra: grava o output style default no settings.json GLOBAL do usuario
 * (~/.claude/settings.json), preservando as demais chaves. Idempotente e
 * best-effort — falha vira pendencia, nunca quebra o setup.
 *
 * INTEGRIDADE DO settings.json (critico — arquivo dificil de arrumar se quebra):
 *   1. JSON invalido/corrompido -> NAO toca (preserva a config alheia).
 *   2. Sanity check round-trip: re-parseia o JSON gerado antes de tocar o disco.
 *   3. Backup do anterior (settings.json.bak) antes de sobrescrever -> rollback.
 *   4. Escrita atomica (tmp + rename) -> nunca deixa o arquivo truncado.
 */
export function applyGlobalOutputStyle(failures, homedir = os.homedir()) {
  log(`[extra] Output style padrao (${DEFAULT_OUTPUT_STYLE}) no settings global`);
  const dir = join(homedir, ".claude");
  const target = join(dir, "settings.json");
  let existingRaw = null;
  try {
    if (existsSync(target)) existingRaw = readFileSync(target, "utf-8");
  } catch (err) {
    failures.push(
      `nao consegui ler ${target} (${err.message}) — defina outputStyle "${DEFAULT_OUTPUT_STYLE}" manualmente.`,
    );
    return;
  }
  const built = buildGlobalSettings(existingRaw);
  if (!built) {
    failures.push(
      `${target} tem JSON invalido — NAO alterado (config preservada); defina outputStyle "${DEFAULT_OUTPUT_STYLE}" manualmente.`,
    );
    return;
  }
  if (!built.changed && existingRaw !== null) {
    log("      Ja configurado — sem alteracao.");
    return;
  }
  // Sanity check: nunca escrever algo que nao re-parseia como esperado.
  try {
    if (JSON.parse(built.json).outputStyle !== DEFAULT_OUTPUT_STYLE) {
      throw new Error("round-trip divergente");
    }
  } catch (err) {
    failures.push(`sanity check do settings falhou (${err.message}) — ${target} NAO alterado.`);
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    if (existingRaw !== null) copyFileSync(target, `${target}.bak`); // rollback do estado anterior
    writeAtomic(target, built.json);
    log("      Definido (sessoes fora de um caso ja nascem nesse style).");
    if (existingRaw !== null) log(`      Backup do anterior: ${target}.bak`);
  } catch (err) {
    failures.push(
      `nao consegui escrever ${target} (${err.message}) — defina outputStyle "${DEFAULT_OUTPUT_STYLE}" manualmente.`,
    );
  }
}

/**
 * Linha de @import (user-scope) do feedback do escritorio no CLAUDE.md global.
 * O sync (sync-cases.mjs) materializa `~/cases/.feedback/FEEDBACK.md` (indice
 * agregado por autor). Com o @import no `~/.claude/CLAUDE.md`, TODA sessao do
 * CC — dentro ou fora de um caso — carrega o feedback do escritorio. User-scope
 * => o CC resolve o @import sem dialog de permissao (validado por spike no
 * Windows: `@~/cases/.feedback/FEEDBACK.md` carrega direto; `~` e expandido).
 */
export const FEEDBACK_IMPORT_LINE = "@~/cases/.feedback/FEEDBACK.md";

/** True se `content` ja tem `line` como uma linha propria (ignorando espacos). */
function hasImportLine(content, line) {
  return content.split(/\r?\n/).some((l) => l.trim() === line);
}

/**
 * Garante a linha de @import do feedback no `~/.claude/CLAUDE.md` (GLOBAL do
 * usuario). Idempotente e best-effort — NUNCA lanca: retorna { changed, error? }
 * (mesmo contrato de applyGlobalOutputStyle; o caller reporta error como
 * pendencia). Casos:
 *   - arquivo ausente    -> cria com header minimo + a linha
 *   - existe SEM a linha  -> backup `.bak-<ts>` + append (linha em branco de
 *     separacao) + escrita atomica
 *   - JA contem a linha   -> no-op (sem backup, sem regravacao)
 *
 * NON-GOAL: nunca toca `<caso>/CLAUDE.md` (briefing da VM). So o CLAUDE.md
 * global e ferramenta de onboarding — os peers/feedback por-caso vem por hook.
 */
export function ensureFeedbackImport(homedir = os.homedir()) {
  const dir = join(homedir, ".claude");
  const target = join(dir, "CLAUDE.md");
  let existing = null;
  try {
    if (existsSync(target)) existing = readFileSync(target, "utf-8");
  } catch (err) {
    return { changed: false, error: `nao consegui ler ${target} (${err.message})` };
  }

  if (existing !== null && hasImportLine(existing, FEEDBACK_IMPORT_LINE)) {
    return { changed: false }; // ja presente -> no-op
  }

  try {
    mkdirSync(dir, { recursive: true });
    if (existing === null) {
      const header =
        "# Instrucoes globais (Claude Code juridico)\n\n" +
        "Feedback do escritorio, agregado pelo espelho de casos e carregado em toda sessao:\n\n";
      writeAtomic(target, `${header}${FEEDBACK_IMPORT_LINE}\n`);
      return { changed: true };
    }
    // Existe sem a linha: backup do estado anterior + append separado por linha em branco.
    copyFileSync(target, `${target}.bak-${Date.now()}`);
    const sep = existing.endsWith("\n") ? "" : "\n";
    writeAtomic(target, `${existing}${sep}\n${FEEDBACK_IMPORT_LINE}\n`);
    return { changed: true };
  } catch (err) {
    return { changed: false, error: `nao consegui escrever ${target} (${err.message})` };
  }
}

/**
 * known_marketplaces.json com autoUpdate ligado no marketplace opc-plugins
 * (CMR-143). Marketplaces de terceiros nascem com auto-update DESLIGADO no
 * CC; sem isso, cada release nosso exige `claude plugin update` manual do
 * usuario. Pura, mesmo contrato de buildGlobalSettings:
 *   - raw ausente/invalido/nao-objeto -> null (arquivo e do CC; nao inventamos
 *     formato nem criamos entrada sem source/installLocation reais)
 *   - entrada `name` ausente ou nao-objeto -> null (marketplace nao registrado)
 *   - entrada presente -> autoUpdate: true; `changed` distingue no-op
 */
export function mergeMarketplaceAutoUpdate(existingRaw, name = "opc-plugins") {
  if (!existingRaw || !existingRaw.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(existingRaw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const entry = obj[name];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const changed = entry.autoUpdate !== true;
  entry.autoUpdate = true;
  return { json: `${JSON.stringify(obj, null, 2)}\n`, changed };
}

/**
 * Aplica mergeMarketplaceAutoUpdate em ~/.claude/plugins/known_marketplaces.json.
 * Best-effort: qualquer impossibilidade vira pendencia em `failures` com a
 * instrucao manual (nunca lanca, nunca cria o arquivo — ele e do CC).
 */
export function applyMarketplaceAutoUpdate(failures, homedir = os.homedir()) {
  log("[extra] Auto-update do marketplace opc-plugins");
  const target = join(homedir, ".claude", "plugins", "known_marketplaces.json");
  const manual =
    `adicione "autoUpdate": true na entrada "opc-plugins" de ${target} ` +
    "(ou atualize plugins manualmente com: claude plugin update).";
  let raw = null;
  try {
    if (existsSync(target)) raw = readFileSync(target, "utf-8");
  } catch (err) {
    failures.push(`nao consegui ler ${target} (${err.message}) — ${manual}`);
    return;
  }
  const merged = mergeMarketplaceAutoUpdate(raw);
  if (merged === null) {
    failures.push(`marketplace opc-plugins nao registrado em ${target} — ${manual}`);
    return;
  }
  if (!merged.changed) {
    log("      Ja ligado — sem alteracao.");
    return;
  }
  try {
    writeAtomic(target, merged.json);
    log("      Ligado: plugins passam a atualizar sozinhos apos o startup do CC.");
  } catch (err) {
    failures.push(`nao consegui escrever ${target} (${err.message}) — ${manual}`);
  }
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
  applyGlobalOutputStyle(failures);
  applyMarketplaceAutoUpdate(failures);

  log("[extra] Feedback do escritorio (@import no CLAUDE.md global)");
  const fb = ensureFeedbackImport();
  if (fb.error) {
    failures.push(`${fb.error} — adicione a linha "${FEEDBACK_IMPORT_LINE}" ao seu ~/.claude/CLAUDE.md.`);
  } else {
    log(fb.changed ? "      Linha de @import garantida." : "      Ja presente — sem alteracao.");
  }

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
