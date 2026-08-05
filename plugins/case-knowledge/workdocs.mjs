/**
 * Sync de documentos de trabalho do caso (workdocs) — logica PURA.
 *
 * Canal que espelha os `.md`/`.py` da pasta do caso entre as maquinas do
 * escritorio (pool comum: mesmo path em todas, qualquer um evolui o arquivo do
 * outro). Extensao do trilho CMR-138 (memoria sincronizavel) — nenhum servico
 * novo; o storage e a propria pasta do caso na VM.
 *
 * Este modulo NAO faz I/O nem rede: so decide. O wiring (fs + HTTP) vive em
 * sync-cases.mjs (`syncWorkdocs`), como o par planMemoriaActions/syncMemoria.
 *
 * Spec: case-docs/docs/superpowers/specs/2026-08-05-sync-workdocs-caso-design.md
 */

// Allowlist de extensao. O SERVIDOR e a autoridade; o cliente filtra por
// economia (nao pedir/subir o que sera recusado) e por seguranca de path.
const WORKDOC_EXTENSIONS = [".md", ".py"];

// Opt-out por sufixo: rascunho pessoal que nunca sai da maquina.
const LOCAL_SUFFIXES = [".local.md", ".local.py"];

// Trilho de briefing proprio (policy `briefing_origin`): o canal workdocs NUNCA
// os toca. Sao os arquivos da RAIZ do caso — um `notas/CLAUDE.md` de subpasta
// nao e briefing e segue sincronizavel. Duplicado de BRIEFING_FILES do
// sync-cases.mjs de proposito: este modulo e puro e nao importa o wiring
// (sync-cases.mjs importa daqui). Mudou la, mudar aqui.
const BRIEFING_ROOT_FILES = ["CLAUDE.md", "case.yaml", "documentos.yaml"];

// Autos e derivados do pipeline, na RAIZ do caso — nao sao workdocs.
const EXCLUDED_ROOT_DIRS = new Set(["_archive", "base", "base_classifier"]);

/** Teto por arquivo (servidor recusa acima disso). */
export const WORKDOC_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Teto por requisicao de upload (o servidor responde 413 acima de 12 MiB;
 * 3 MiB por batch deixa folga e mantem a requisicao curta). */
export const WORKDOC_MAX_BATCH_BYTES = 3 * 1024 * 1024;
/** Teto por CICLO: o tick roda a cada 5 min (e a tarefa do Windows tem
 * ExecutionTimeLimit de 5 min) — um backfill grande e fatiado entre ticks. */
export const WORKDOC_MAX_TICK_BYTES = 12 * 1024 * 1024;
/** Maximo de arquivos por requisicao (espelha o batch da memoria). */
export const WORKDOC_MAX_BATCH_FILES = 50;

// Folga por arquivo para o envelope JSON ({"files":[{"path","content"}]}).
const UPLOAD_ENVELOPE_RESERVE = 64;

/**
 * Normaliza o valor de um arquivo (manifest/baseline/estado local) para a
 * string md5. O manifest do servidor usa `{ md5 }`; baseline e estado local
 * usam md5 plano. Aceita ambos; qualquer outra coisa -> undefined.
 */
function fileMd5(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.md5 === "string") return v.md5;
  return undefined;
}

/**
 * Espelho client-side do `is_workdoc_path` do servidor: decide pelo PATH
 * RELATIVO canonico (separador `/`, sem prefixo do caso).
 *
 * Aceita: `.md`/`.py` em qualquer profundidade.
 * Rejeita: extensao fora da allowlist; `*.local.md`/`*.local.py`; os 3 arquivos
 * de briefing na raiz; `_archive/`, `base/`, `base_classifier/` na raiz;
 * dotfile/dot-dir em QUALQUER segmento; path absoluto, `..`, segmento vazio,
 * separador `\` (nao-canonico) e NUL.
 */
export function isWorkdocPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (relPath.includes("\\") || relPath.includes("\0")) return false;
  if (relPath.startsWith("/")) return false; // absoluto POSIX
  if (/^[A-Za-z]:/.test(relPath)) return false; // absoluto Windows

  const segs = relPath.split("/");
  for (const seg of segs) {
    // `.` e `..` ja caem no startsWith("."); explicitos por clareza.
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return false;
  }

  const name = segs[segs.length - 1];
  if (!WORKDOC_EXTENSIONS.some((ext) => name.endsWith(ext))) return false;
  if (LOCAL_SUFFIXES.some((suf) => name.endsWith(suf))) return false;
  if (segs.length === 1 && BRIEFING_ROOT_FILES.includes(name)) return false;
  if (segs.length > 1 && EXCLUDED_ROOT_DIRS.has(segs[0])) return false;
  return true;
}

// Slug de autor seguro como pedaco de NOME de arquivo (nunca um segmento de
// path proprio): sem `/`, `\`, `..`.
const VALID_AUTHOR_SLUG = /^[A-Za-z0-9._-]+$/;

/**
 * Nome do arquivo onde a versao REMOTA materializa quando ha conflito:
 * `<nome>.conflito-<author_slug><ext>`, na mesma pasta do original. O local
 * fica intacto — nunca se perde texto.
 *
 * O slug e o do PROPRIO usuario (claim `author_dir` do JWT): o pool e comum e
 * o cliente nao sabe quem escreveu a versao remota; o slug serve para nao
 * colidir quando duas maquinas materializam o conflito do mesmo arquivo (a
 * copia e ela propria um `.md`/`.py` e sincroniza depois).
 *
 * Retorna null quando path ou slug sao invalidos — o caller nao escreve nada.
 */
export function conflictPath(relPath, authorSlug) {
  if (!isWorkdocPath(relPath)) return null;
  if (typeof authorSlug !== "string" || !VALID_AUTHOR_SLUG.test(authorSlug)) return null;
  if (authorSlug === "." || authorSlug === "..") return null;
  const ext = WORKDOC_EXTENSIONS.find((e) => relPath.endsWith(e));
  if (!ext) return null;
  return `${relPath.slice(0, -ext.length)}.conflito-${authorSlug}${ext}`;
}

/**
 * Decide o que baixar, subir e o que e conflito para UM caso.
 *
 *   manifest:   { <path>: md5|{md5} }  — o que o servidor tem
 *   localFiles: { <path>: md5|{md5} }  — o que ha no disco
 *   baseline:   { <path>: md5|{md5} }  — estado do ultimo sync
 *
 * Retorna { downloads: [path], uploads: [path], conflicts: [path], warnings: [] }
 * (listas ordenadas — plano deterministico).
 *
 * Regras (R=remoto, L=local, B=baseline):
 *   R sem L, sem B          -> download (arquivo novo no server)
 *   R sem L, com B          -> download (delecao local NAO propaga)
 *   L === R                 -> nada
 *   L === B, R !== B        -> download (server mudou, local intocado)
 *   R === B, L !== B        -> upload   (local mudou, server intocado)
 *   L !== B, R !== B, L!==R -> conflito (os dois lados mudaram)
 *   L !== R sem B           -> conflito (bootstrap: nao da para saber quem
 *                              mudou; preservar os dois e a saida nao-destrutiva)
 *   L sem R, sem B          -> upload   (arquivo novo local)
 *   L sem R, com B          -> nada     (delecao no server nao destroi local)
 *
 * Paths fora da allowlist sao descartados com aviso — o manifest e dado remoto
 * nao-confiavel e cada path vira caminho no disco do cliente.
 */
export function planWorkdocsSync({ manifest, localFiles, baseline } = {}) {
  const plan = { downloads: [], uploads: [], conflicts: [], warnings: [] };
  const remote = manifest || {};
  const local = localFiles || {};
  const base = baseline || {};

  const paths = new Set();
  for (const p of Object.keys(remote)) {
    if (isWorkdocPath(p)) paths.add(p);
    else plan.warnings.push(`manifest: path fora da allowlist descartado: ${p}`);
  }
  for (const p of Object.keys(local)) {
    if (isWorkdocPath(p)) paths.add(p);
  }

  for (const p of [...paths].sort()) {
    const r = fileMd5(remote[p]);
    const l = fileMd5(local[p]);
    const b = fileMd5(base[p]);

    if (r === undefined) {
      // So existe local: sobe se nunca foi sincronizado; se ja esteve no
      // baseline, sumiu no server -> nao ressuscita nem apaga (v1).
      if (l !== undefined && b === undefined) plan.uploads.push(p);
      continue;
    }
    if (l === undefined) {
      plan.downloads.push(p); // seed ou delecao local (que nao propaga)
      continue;
    }
    if (l === r) continue; // em dia
    if (b !== undefined && l === b) plan.downloads.push(p);
    else if (b !== undefined && r === b) plan.uploads.push(p);
    else plan.conflicts.push(p);
  }
  return plan;
}

/**
 * Novo baseline do caso apos aplicar o plano. Analogo a computeMemoriaBaseline.
 *
 *   downloaded/uploaded/conflicted: Set de paths que TIVERAM EXITO neste ciclo.
 *
 *   - baixado          -> md5 do server (local passou a ser igual)
 *   - conflito materializado -> md5 do server: a versao remota ja foi
 *     preservada ao lado, entao o local deixa de ser "divergente sem base" e
 *     sobe no proximo ciclo. Sem isso o par ficaria congelado em conflito para
 *     sempre e a resolucao manual nunca propagaria.
 *   - subido           -> md5 local (o server passou a te-lo)
 *   - ja sincronizado  -> md5 comum
 *   - falha            -> mantem o baseline anterior (o proximo ciclo e o retry)
 *   - sumiu dos dois lados -> entrada removida
 */
export function computeWorkdocsBaseline({
  manifest,
  localFiles,
  baseline,
  downloaded,
  uploaded,
  conflicted,
} = {}) {
  const remote = manifest || {};
  const local = localFiles || {};
  const prev = baseline || {};
  const dl = downloaded || new Set();
  const up = uploaded || new Set();
  const cf = conflicted || new Set();

  const next = {};
  const paths = new Set(
    [...Object.keys(remote), ...Object.keys(local), ...Object.keys(prev)].filter(isWorkdocPath),
  );

  for (const p of [...paths].sort()) {
    const r = fileMd5(remote[p]);
    const l = fileMd5(local[p]);
    const b = fileMd5(prev[p]);
    if (r === undefined && l === undefined) continue; // orfao dos dois lados
    if (dl.has(p) && r !== undefined) next[p] = r;
    else if (cf.has(p) && r !== undefined) next[p] = r;
    else if (up.has(p) && l !== undefined) next[p] = l;
    else if (r !== undefined && r === l) next[p] = r;
    else if (b !== undefined) next[p] = b;
  }
  return next;
}

/**
 * Agrupa uploads em batches respeitando os tetos do canal. Pura: recebe
 * `[{ case, path, size }]` (size em BYTES CRUS do disco) e nao le arquivo —
 * so o que entra em `batches` precisa ser lido pelo caller.
 *
 * O custo orcado e o do corpo REAL: o conteudo viaja em base64 (4/3 do bruto)
 * mais o path e a folga do envelope JSON.
 *
 * Retorna { batches: [[file]], skipped: [{case,path,reason}], deferred: [file] }.
 * `deferred` = o que estourou o teto do CICLO — vai no proximo tick, nao se perde.
 */
export function planWorkdocUploadBatches(files, caps = {}) {
  const maxFile = caps.maxFileBytes ?? WORKDOC_MAX_FILE_BYTES;
  const maxBatch = caps.maxBatchBytes ?? WORKDOC_MAX_BATCH_BYTES;
  const maxTick = caps.maxTickBytes ?? WORKDOC_MAX_TICK_BYTES;
  const maxFiles = caps.maxBatchFiles ?? WORKDOC_MAX_BATCH_FILES;

  const batches = [];
  const skipped = [];
  const deferred = [];
  let cur = [];
  let curBytes = 0;
  let tickBytes = 0;
  let cheio = false;

  for (const f of files || []) {
    const size = typeof f?.size === "number" ? f.size : 0;
    if (cheio) {
      deferred.push(f);
      continue;
    }
    if (size > maxFile) {
      skipped.push({ case: f.case, path: f.path, reason: "acima de 2 MiB (teto por arquivo)" });
      continue;
    }
    const cost =
      Math.ceil(size / 3) * 4 + Buffer.byteLength(String(f.path ?? ""), "utf-8") + UPLOAD_ENVELOPE_RESERVE;
    if (tickBytes + cost > maxTick) {
      // Teto do ciclo: adia ESTE e todos os seguintes (corte deterministico).
      cheio = true;
      deferred.push(f);
      continue;
    }
    if (cur.length >= maxFiles || (cur.length > 0 && curBytes + cost > maxBatch)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += cost;
    tickBytes += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return { batches, skipped, deferred };
}
