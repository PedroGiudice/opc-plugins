/**
 * Sync de documentos de trabalho do caso (workdocs) — lógica PURA.
 *
 * Canal que espelha os `.md`/`.py` da pasta do caso entre as máquinas do
 * escritório (pool comum: mesmo path em todas, qualquer um evolui o arquivo do
 * outro). Extensão do trilho CMR-138 (memória sincronizável) — nenhum serviço
 * novo; o storage é a própria pasta do caso na VM.
 *
 * Este módulo NÃO faz I/O nem rede: só decide. O wiring (fs + HTTP) vive em
 * sync-cases.mjs (`syncWorkdocs`), como o par planMemoriaActions/syncMemoria.
 *
 * Spec: case-docs/docs/superpowers/specs/2026-08-05-sync-workdocs-caso-design.md
 */

// Allowlist de extensão (sem ponto, comparada em MINÚSCULAS — espelha
// `WORKDOC_EXTENSIONS` do servidor). O SERVIDOR é a autoridade; o cliente
// filtra por economia (não pedir/subir o que seria recusado) e por segurança
// de path.
const WORKDOC_EXTENSIONS = ["md", "py"];

// Opt-out pessoal: stem terminado em `.local` (`rascunho.local.md`). Espelha
// `WORKDOC_OPT_OUT_SUFFIX` do servidor.
const WORKDOC_OPT_OUT_SUFFIX = ".local";

// Trilho de briefing próprio (policy `briefing_origin`): o canal workdocs NUNCA
// os toca. Barrados por BASENAME em QUALQUER profundidade e em QUALQUER CAIXA —
// `CLAUDE.md` é instrução do agente, nunca documento de trabalho (fronteira
// casada com o servidor). Duplicado de BRIEFING_FILES do sync-cases.mjs de
// propósito: este módulo é puro e não importa o wiring (sync-cases.mjs importa
// daqui).
const BRIEFING_FILES = ["CLAUDE.md", "case.yaml", "documentos.yaml"];
const BRIEFING_FILES_LOWER = new Set(BRIEFING_FILES.map(asciiLower));

/**
 * Diretórios barrados em QUALQUER segmento. Exportado para o scan local podar
 * essas árvores antes de descer nelas.
 *
 * Os SETE nomes espelham `WORKDOC_EXCLUDED_DIRS` do servidor (`api.rs`) — as
 * duas pontas barram o mesmo conjunto, sem divergência. Os três primeiros são
 * autos e derivados do pipeline; os quatro últimos são árvores de DEPENDÊNCIA:
 * um `venv/` ao lado de um script tem milhares de `.py` que não são trabalho de
 * ninguém — sem esta poda o canal viraria um upload em massa perpétuo.
 */
export const WORKDOC_EXCLUDED_DIRS = new Set([
  "_archive",
  "base",
  "base_classifier",
  "venv",
  "node_modules",
  "__pycache__",
  "site-packages",
]);

/** Profundidade máxima da varredura (espelha `WORKDOCS_MAX_DEPTH` do servidor). */
export const WORKDOC_MAX_DEPTH = 12;

/**
 * `true` se `name` é um diretório barrado do canal, comparado SEM CAIXA
 * (espelha `is_excluded_dir_name` do servidor). O cliente roda em NTFS, onde
 * `Base/` e `base/` são a MESMA pasta: comparar com caixa deixaria os autos
 * entrarem no canal e, no upload, o servidor recusaria item a item para sempre
 * (o baseline nunca avança -> re-envio a cada tick).
 */
export function isExcludedDirName(name) {
  return typeof name === "string" && WORKDOC_EXCLUDED_DIRS.has(asciiLower(name));
}

// Marca da cópia de conflito. Cópia de conflito NÃO é workdoc elegível: é
// material de reconciliação LOCAL da máquina onde nasceu. Não sobe, não entra
// no baseline como workdoc — assim não difunde lixo pelo escritório e apagá-la
// localmente não a traz de volta (ela nunca esteve no servidor).
const CONFLICT_MARKER = ".conflito-";

/** Teto por arquivo (servidor recusa acima disso). */
export const WORKDOC_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Teto por requisição de upload (o servidor responde 413 acima de 12 MiB;
 * 3 MiB por batch deixa folga e mantém a requisição curta). */
export const WORKDOC_MAX_BATCH_BYTES = 3 * 1024 * 1024;
/** Teto por CICLO: o tick roda a cada 5 min (e a tarefa do Windows tem
 * ExecutionTimeLimit de 5 min) — um backfill grande é fatiado entre ticks. */
export const WORKDOC_MAX_TICK_BYTES = 12 * 1024 * 1024;
// Máximo de arquivos por requisição (espelha o batch da memória). Interno: só
// `planWorkdocUploadBatches` o consome, como default do cap `maxBatchFiles`.
const WORKDOC_MAX_BATCH_FILES = 50;

// Folga por arquivo para o envelope JSON ({"files":[{"path","content"}]}).
const UPLOAD_ENVELOPE_RESERVE = 64;

/**
 * Normaliza o valor de um arquivo (manifest/baseline/estado local) para a
 * string md5. O manifest do servidor usa `{ md5 }`; baseline e estado local
 * usam md5 plano. Aceita ambos; qualquer outra coisa -> undefined (é assim que
 * o marcador `{oversize:true}` vira "presente e inelegível").
 */
function fileMd5(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.md5 === "string") return v.md5;
  return undefined;
}

/**
 * Par de conflito registrado no baseline: `{conflito: {local, remoto}}` — os
 * dois md5 do momento em que a cópia `.conflito-` foi materializada. É o que
 * CONGELA o par até haver ação humana. Forma inválida (estado corrompido, ou
 * baseline de uma versão anterior) devolve undefined e o path cai nas regras
 * normais — nunca lança.
 */
function conflitoPar(v) {
  const c = v && typeof v === "object" ? v.conflito : undefined;
  if (c && typeof c === "object" && typeof c.local === "string" && typeof c.remoto === "string") {
    return { local: c.local, remoto: c.remoto };
  }
  return undefined;
}

/**
 * Guards de PATH, sem julgar o conteúdo: path relativo canônico (separador
 * `/`), sem `\`, sem `:` (absoluto Windows e ADS de NTFS), sem caractere de
 * controle, sem segmento vazio (cobre absoluto POSIX, `a//b` e `nota.md/`) e
 * sem segmento iniciado por ponto (cobre `.`, `..` e todo dotfile/dot-dir).
 *
 * "Caractere de controle" é a categoria Unicode Cc INTEIRA — C0
 * (U+0000-U+001F) **e C1** (U+007F-U+009F) —, exatamente o `char::is_control()`
 * do servidor. A faixa C1 não é teórica: o NTFS aceita 0x80-0x9F em nome de
 * arquivo, então parar em U+007F deixaria o cliente aceitar um path que o
 * servidor recusa — o arquivo subiria e voltaria em `failed` a cada tick, com o
 * baseline travado para sempre.
 *
 * Usado por `isWorkdocPath` e, sozinho, pelo destino da cópia de conflito —
 * que não é workdoc elegível mas continua tendo que cair dentro da pasta do
 * caso.
 */
export function isSafeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (relPath.includes("\\") || relPath.includes(":")) return false;
  if (/[\u0000-\u001F\u007F-\u009F]/.test(relPath)) return false;
  for (const seg of relPath.split("/")) {
    if (seg === "" || seg.startsWith(".")) return false;
  }
  return true;
}

/** Minúsculas ASCII, como o `to_ascii_lowercase` do servidor (o `toLowerCase`
 * do JS é Unicode-aware e divergiria em nomes exóticos). */
function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Espelho client-side do `is_workdoc_path` do servidor: decide pelo PATH
 * RELATIVO canônico (separador `/`, sem prefixo do caso).
 *
 * Aceita: `.md`/`.py` (extensão case-insensitive) em qualquer profundidade.
 * Rejeita: extensão fora da allowlist; stem terminado em `.local`; os 3
 * arquivos de briefing por BASENAME em qualquer profundidade; `_archive/`,
 * `base/`, `base_classifier/` e árvores de dependência em QUALQUER segmento de
 * diretório; dotfile/dot-dir em qualquer segmento; cópia de conflito; path
 * absoluto, `..`, segmento vazio, `\`, `:` e caractere de controle.
 */
export function isWorkdocPath(relPath) {
  if (!isSafeRelPath(relPath)) return false;

  const segs = relPath.split("/");
  const name = segs[segs.length - 1];
  const lower = asciiLower(name);

  // TODA comparação de nome é SEM CAIXA, como no servidor (o cliente é
  // Windows/NTFS: `Base/` e `base/` são a mesma pasta, `claude.md` é o mesmo
  // arquivo que o `CLAUDE.md` curado do trilho de briefing).
  for (let i = 0; i < segs.length - 1; i++) {
    if (isExcludedDirName(segs[i])) return false;
  }
  if (BRIEFING_FILES_LOWER.has(lower)) return false;
  if (lower.includes(CONFLICT_MARKER)) return false;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return false; // sem extensão, ou stem vazio
  const stem = lower.slice(0, dot);
  const ext = lower.slice(dot + 1);
  if (!WORKDOC_EXTENSIONS.includes(ext)) return false;
  if (stem.endsWith(WORKDOC_OPT_OUT_SUFFIX)) return false;
  return true;
}

// Slug de autor seguro como pedaço de NOME de arquivo (nunca um segmento de
// path próprio): sem `/`, `\`, `..`.
const VALID_AUTHOR_SLUG = /^[A-Za-z0-9._-]+$/;

/**
 * Nome do arquivo onde a versão REMOTA materializa quando há conflito:
 * `<nome>.conflito-<author_slug><ext>`, na mesma pasta do original e com a
 * caixa da extensão preservada. O local fica intacto — nunca se perde texto.
 *
 * A cópia é material de reconciliação LOCAL: `isWorkdocPath` a rejeita, então
 * ela não sobe nem circula pelo escritório. O slug (claim `author_dir` do JWT)
 * fica no nome para deixar explícito de qual máquina veio a reconciliação.
 *
 * Retorna null quando path ou slug são inválidos — o caller não escreve nada.
 */
export function conflictPath(relPath, authorSlug) {
  if (!isWorkdocPath(relPath)) return null;
  if (typeof authorSlug !== "string" || !VALID_AUTHOR_SLUG.test(authorSlug)) return null;
  if (authorSlug === "." || authorSlug === "..") return null;
  // `isWorkdocPath` garante extensão no último segmento -> o último ponto do
  // path inteiro é o separador da extensão.
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return null;
  return `${relPath.slice(0, dot)}${CONFLICT_MARKER}${authorSlug}${relPath.slice(dot)}`;
}

/**
 * Decide o que baixar, subir e o que é conflito para UM caso.
 *
 *   manifest:   { <path>: md5|{md5} }  — o que o servidor tem
 *   localFiles: { <path>: md5|{md5}|{motivo} } — o que há no disco
 *   baseline:   { <path>: md5|{md5}|{conflito:{local,remoto}} } — último sync
 *
 * PRESENTE-E-INELEGÍVEL: uma entrada local com a CHAVE presente mas SEM md5
 * significa "existe no disco, o canal não o transporta" — acima do teto por
 * arquivo, ilegível (EACCES, lock de editor) ou não-regular (symlink). É
 * inerte: não baixa (baixar SOBRESCREVERIA o trabalho local), não sobe, não
 * vira conflito — só avisa, com o `motivo` da entrada quando houver.
 * Ausência de CHAVE é o único "não existe local"; qualquer dúvida sobre o
 * arquivo tem que virar chave presente, nunca sumiço.
 *
 * CONFLITO CONGELA ATÉ AÇÃO HUMANA. Quando o conflito é materializado, o
 * baseline guarda o PAR `{local, remoto}` daquele instante. Enquanto os dois
 * lados continuarem iguais ao par, o arquivo é INERTE (`frozen`): a cópia
 * `.conflito-` já está no disco ao lado, então nada se perdeu, e nem o local
 * sobe por cima do servidor nem o remoto desce por cima do local. A saída é
 * humana: o usuário reconcilia (o LOCAL muda -> upload) ou o hub evolui (o
 * REMOTO muda -> conflito novo, rematerializa a cópia). Se os DOIS mudaram,
 * é conflito novo — subir ali perderia a versão nova do servidor.
 *
 * Medição que motivou a política: no primeiro tick de uma máquina real foram 15
 * conflitos, 14 em `MAPA_PROCESSUAL.md`; com o baseline adotando o md5 remoto,
 * o tick seguinte subia o local ANTIGO por cima da versão atual do hub, e a
 * próxima máquina baixava a versão ruim.
 *
 * Retorna { downloads, uploads, conflicts, frozen, warnings } (listas ordenadas
 * — plano determinístico).
 *
 * Regras (R=remoto, L=local, B=baseline, P=par de conflito):
 *   R sem L, sem B          -> download (arquivo novo no server)
 *   R sem L, com B ou P     -> download (deleção local NÃO propaga)
 *   L === R                 -> nada (sai do congelamento, se houver par)
 *   com P, R !== P.remoto   -> conflito (hub evoluiu; rematerializa)
 *   com P, L !== P.local    -> upload   (houve reconciliação humana)
 *   com P, os dois parados  -> frozen   (inerte até ação humana)
 *   L === B, R !== B        -> download (server mudou, local intocado)
 *   R === B, L !== B        -> upload   (local mudou, server intocado)
 *   L !== B, R !== B, L!==R -> conflito (os dois lados mudaram)
 *   L !== R sem B           -> conflito (bootstrap: não dá para saber quem
 *                              mudou; preservar os dois é a saída não-destrutiva)
 *   L sem R, sem B          -> upload   (arquivo novo local)
 *   L sem R, com B          -> nada     (deleção no server não destrói local)
 *
 * Paths fora da allowlist são descartados com aviso — o manifest é dado remoto
 * não-confiável e cada path vira caminho no disco do cliente.
 */
export function planWorkdocsSync({ manifest, localFiles, baseline } = {}) {
  const plan = { downloads: [], uploads: [], conflicts: [], frozen: [], warnings: [] };
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
    const par = conflitoPar(base[p]);
    const b = fileMd5(base[p]);

    // Presente no disco mas fora do que o canal transporta: intocável.
    if (l === undefined && Object.prototype.hasOwnProperty.call(local, p)) {
      const motivo =
        typeof local[p]?.motivo === "string" ? local[p].motivo : "não transportável pelo canal";
      plan.warnings.push(
        `local presente e inelegível (${motivo}): ${p} -> preservado, sem download nem upload`,
      );
      continue;
    }

    if (r === undefined) {
      // Só existe local: sobe se nunca foi sincronizado; se já esteve no
      // baseline (md5 ou par), sumiu no server -> não ressuscita nem apaga (v1).
      if (l !== undefined && b === undefined && par === undefined) plan.uploads.push(p);
      continue;
    }
    if (l === undefined) {
      plan.downloads.push(p); // seed ou deleção local (que não propaga)
      continue;
    }
    if (l === r) continue; // em dia (colapsa o par, se houver)

    if (par !== undefined) {
      // Conflito congelado: só ação humana descongela. Remoto primeiro — se o
      // hub andou, subir o local perderia a versão nova.
      if (r !== par.remoto) plan.conflicts.push(p);
      else if (l !== par.local) plan.uploads.push(p);
      else plan.frozen.push(p);
      continue;
    }

    if (b !== undefined && l === b) plan.downloads.push(p);
    else if (b !== undefined && r === b) plan.uploads.push(p);
    else plan.conflicts.push(p);
  }
  return plan;
}

/**
 * Novo baseline do caso após aplicar o plano. Análogo a computeMemoriaBaseline.
 *
 *   downloaded/conflicted: Map `path -> md5 dos bytes GRAVADOS` (Set também é
 *     aceito, caindo no md5 do manifest). O md5 real importa: o servidor pode
 *     ter mudado entre o manifest e o fetch, e um baseline que não descreve o
 *     byte em disco faz o ciclo seguinte inventar mudança.
 *   uploaded: Set (ou Map) de paths que o servidor aceitou.
 *
 *   - baixado          -> md5 do que foi gravado (local passou a ser igual)
 *   - conflito materializado -> PAR `{conflito:{local, remoto}}`: os dois md5
 *     do instante em que a cópia foi gravada. É o par que CONGELA o arquivo até
 *     ação humana (ver `planWorkdocsSync`). NÃO grava o md5 remoto solto: isso
 *     mandaria o local subir por cima do hub no tick seguinte — foi o defeito
 *     que o review final mediu em produção. Conflito NÃO materializado não
 *     entra aqui (mantém o baseline anterior).
 *   - subido           -> md5 local (o server passou a tê-lo; colapsa o par)
 *   - já sincronizado  -> md5 comum (colapsa o par: os lados convergiram)
 *   - falha            -> mantém o baseline anterior (o próximo ciclo é o retry)
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

  // md5 REAL do que foi gravado, quando a coleção o carrega (Map); Set não
  // carrega e cai no fallback (md5 do manifest).
  const md5Gravado = (col, p) => {
    const v = typeof col?.get === "function" ? col.get(p) : undefined;
    return typeof v === "string" ? v : undefined;
  };

  for (const p of [...paths].sort()) {
    const r = fileMd5(remote[p]);
    const l = fileMd5(local[p]);
    const b = fileMd5(prev[p]);
    const par = conflitoPar(prev[p]);
    const localInelegivel = l === undefined && Object.prototype.hasOwnProperty.call(local, p);
    if (r === undefined && l === undefined && !localInelegivel) continue; // órfão dos dois lados
    if (dl.has(p)) next[p] = md5Gravado(dl, p) ?? r;
    else if (cf.has(p)) {
      // Par do instante da materialização: é o que congela até ação humana.
      const remoto = md5Gravado(cf, p) ?? r;
      if (l !== undefined && remoto !== undefined) next[p] = { conflito: { local: l, remoto } };
      else if (b !== undefined) next[p] = b;
    } else if (up.has(p) && l !== undefined) next[p] = l;
    else if (r !== undefined && r === l) next[p] = r;
    else if (par !== undefined) next[p] = { conflito: { ...par } }; // segue congelado
    else if (b !== undefined) next[p] = b;
    if (next[p] === undefined) delete next[p];
  }
  return next;
}

/**
 * Agrupa uploads em batches respeitando os tetos do canal. Pura: recebe
 * `[{ case, path, size }]` (size em BYTES CRUS do disco) e não lê arquivo —
 * só o que entra em `batches` precisa ser lido pelo caller.
 *
 * O custo orçado é o do corpo REAL: o conteúdo viaja em base64 (4/3 do bruto)
 * mais o path e a folga do envelope JSON.
 *
 * Retorna { batches: [[file]], skipped: [{case,path,reason}], deferred: [file] }.
 * `deferred` = o que estourou o teto do CICLO — vai no próximo tick, não se perde.
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
      // Teto do ciclo: adia ESTE e todos os seguintes (corte determinístico).
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
