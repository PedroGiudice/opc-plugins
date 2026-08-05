#!/usr/bin/env node
/**
 * Espelho de casos VM -> maquina cliente (cmr-002).
 *
 * Fluxo: GET /cases/sync-manifest -> compara md5 local -> baixa via
 * GET /cases/{name}/briefing so o que mudou -> move orfaos p/ _archive.
 * NUNCA deleta nada; so escreve nos arquivos de briefing.
 *
 * Agendado pelo Task Scheduler (a cada 5 min + logon, via sync-cases-hidden.vbs). Exit 0 sempre —
 * erro e logado em ~/cases/.sync.log e o proximo ciclo e o retry.
 *
 * Spec: case-docs/docs/superpowers/specs/2026-06-11-sync-vm-cmr002-mirror-design.md
 */

import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  writeFileSync, renameSync, appendFileSync, copyFileSync, rmdirSync, unlinkSync,
  statSync, openSync, readSync, closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { requestWithAuth, readCredential, decodeJwtAuthorDir } from "./auth.mjs";
import { defaultMemApiBase } from "./memoria.mjs";
import { isSafeScaffoldingPath } from "./setup.mjs";
import {
  isWorkdocPath,
  isSafeRelPath,
  conflictPath,
  planWorkdocsSync,
  computeWorkdocsBaseline,
  planWorkdocUploadBatches,
  isExcludedDirName,
  WORKDOC_MAX_DEPTH,
  WORKDOC_MAX_FILE_BYTES,
} from "./workdocs.mjs";

// Espelha defaultApiBase/defaultCasesBase do server.mjs. Duplicado de
// proposito: importar server.mjs executaria o server MCP (connect no
// top-level). Se mudar la, mudar aqui.
function defaultApiBase() {
  if (process.platform === "win32") return "https://api.aidvlabs.com/api";
  return "http://127.0.0.1:8422/api";
}
function defaultCasesBase() {
  if (process.platform === "win32") return join(process.env.USERPROFILE || "C:\\Users\\pedro", "cases");
  return "/home/opc/case-docs/cases";
}

export const BRIEFING_FILES = ["CLAUDE.md", "case.yaml", "documentos.yaml"];
const EXCLUDED_DIRS = new Set(["_archive", "_template", "scripts"]);

export function isExcluded(name) {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

export function md5hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

// Whitelist client-side de nome de caso (espelha valid_case_name do
// servidor): alfanumerico ASCII no inicio, depois `.` `_` `-` permitidos.
// Bloqueia path traversal por construcao (sem `/`, `\` ou prefixo `.`).
const VALID_CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Decide acoes a partir do manifest remoto e do estado local.
 * localState: { caseName: { fileName: md5hex } } — TODOS os dirs locais;
 * exclusoes (_archive, _template, scripts, dotdirs) sao tratadas aqui.
 * Retorna { mkdir: [name], download: [{name, files}], orphans: [name] }.
 *
 * Defesa client-side: a invariante "so escreve nos arquivos de briefing"
 * e garantida AQUI (quem decide o que tocar no disco), nao so no servidor
 * — nome remoto invalido/reservado e arquivo fora de BRIEFING_FILES sao
 * descartados do plano.
 *
 * Matching de nome e case-insensitive (NTFS): se a VM renomear a caixa de
 * um caso, o cliente reusa o dir local existente em vez de criar duplicata
 * e arquivar o antigo (que carregaria o trabalho local do advogado junto).
 */
export function planActions(manifestCases, localState, baseline = {}) {
  const plan = { mkdir: [], download: [], orphans: [], conflicts: [] };

  // Defesa em profundidade: manifest vazio significa quase certamente erro
  // no servidor (a VM tem 20+ casos ativos), nunca "arquive tudo".
  if (manifestCases.length === 0) return plan;

  // Indice lowercase do estado local para matching NTFS-safe.
  const localByLower = new Map();
  for (const name of Object.keys(localState)) {
    localByLower.set(name.toLowerCase(), name);
  }

  const remoteLower = new Set();
  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    remoteLower.add(c.name.toLowerCase());

    // Reusa o dir local existente quando so a caixa difere (NTFS).
    const localName = localByLower.get(c.name.toLowerCase());
    const local = localName !== undefined ? localState[localName] : undefined;
    const base = (localName !== undefined ? baseline[localName] : undefined) ?? baseline[c.name];
    const targetName = localName ?? c.name;
    if (!local) plan.mkdir.push(c.name);

    const needs = [];
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const localMd5 = local?.[file];
      const baseMd5 = base?.[file];
      if (localMd5 === undefined) {
        needs.push(file); // arquivo novo no cliente
      } else if (localMd5 === info.md5) {
        // ja sincronizado: nada a fazer
      } else if (baseMd5 !== undefined && localMd5 === baseMd5) {
        needs.push(file); // VM mudou, local intocado desde o ultimo download
      } else {
        plan.conflicts.push({ name: targetName, file }); // edicao local -> preserva
      }
    }
    if (needs.length > 0) plan.download.push({ name: targetName, files: needs });
  }

  // Um dir local ausente do manifest so e orfao se o sync ja o trouxe antes
  // (presente no baseline) -> caso removido na VM, limpeza legitima. Um dir que
  // o sync nunca sincronizou (ausente do baseline) e trabalho local do usuario
  // (ex: contrato jogado em ~/cases para revisao): NAO tocar. O espelho mexe so
  // no que e dele.
  const baselineLower = new Set(Object.keys(baseline).map((k) => k.toLowerCase()));
  for (const name of Object.keys(localState)) {
    if (remoteLower.has(name.toLowerCase()) || isExcluded(name)) continue;
    if (baselineLower.has(name.toLowerCase())) plan.orphans.push(name);
  }
  return plan;
}

/**
 * Novo baseline a persistir apos aplicar o plano. Reflete o md5 da VM para
 * arquivos agora sincronizados (baixados com sucesso OU ja iguais a VM);
 * preserva o baseline anterior para conflitos (a versao da VM de quando o
 * usuario editou); remove orfaos (casos ausentes do manifest).
 *
 * succeeded: Set de chaves `${name} ${file}` baixadas com sucesso neste ciclo.
 */
export function computeBaseline(manifestCases, localState, prevBaseline, succeeded) {
  const next = {};
  const localByLower = new Map();
  for (const name of Object.keys(localState)) {
    localByLower.set(name.toLowerCase(), name);
  }

  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    const localName = localByLower.get(c.name.toLowerCase()) ?? c.name;
    const local = localState[localName];
    const prev = prevBaseline[localName] ?? prevBaseline[c.name] ?? {};
    const entry = {};
    for (const [file, info] of Object.entries(c.files)) {
      if (!BRIEFING_FILES.includes(file)) continue;
      const key = `${localName} ${file}`;
      if (succeeded.has(key)) {
        entry[file] = info.md5; // baixado -> agora igual a VM
      } else if (local?.[file] === info.md5) {
        entry[file] = info.md5; // ja sincronizado -> adota
      } else if (prev[file] !== undefined) {
        entry[file] = prev[file]; // conflito/falha -> mantem
      }
    }
    if (Object.keys(entry).length > 0) next[localName] = entry;
  }
  return next;
}

// ---------- CMR-138: memoria de caso sincronizavel (por-autor) ----------
//
// A memoria de caso e uma arvore por-autor: cada advogado (tenant/autor) tem seu
// subdir; peers baixados vivem em `.memoria/<peer>/`, a memoria do proprio autor
// (auto-memory) e a fonte dos uploads. Estas puras decidem o que baixar (peers +
// self sob never-overwrite) e o que subir (SO os arquivos do proprio autor,
// roteados para memoria-de-caso ou pool-de-feedback). Wiring (fs/rede) e a Task 10.

/**
 * Normaliza o valor de um arquivo no manifest/baseline/estado local para a
 * string md5. O server real usa md5 STRING PLANA; os testes e o manifest
 * teorico usam objeto `{ md5, content? }`. Aceita ambos; qualquer outra coisa
 * (undefined, numero, etc) -> undefined.
 */
function fileMd5(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.md5 === "string") return v.md5;
  return undefined;
}

/** Conteudo do arquivo (para upload). So o shape objeto `{ content }` carrega. */
function fileContent(v) {
  if (v && typeof v === "object" && typeof v.content === "string") return v.content;
  return undefined;
}

// PEERS.md e um indice gerado dentro do dir de memoria, nunca um arquivo de
// autor -- fica fora de download e upload.
const MEMORIA_IGNORED = new Set(["PEERS.md"]);

// FEEDBACK.md e o indice gerado do pool de feedback (fica na raiz de `.feedback/`,
// nao em subdir de autor); nunca um arquivo de autor.
const FEEDBACK_IGNORED = new Set(["FEEDBACK.md"]);

/**
 * Le o `type` declarado no frontmatter YAML (bloco entre `---` no INICIO do
 * arquivo). Sem lib YAML: varre as linhas do bloco e casa `type: <valor>`
 * (top-level OU aninhado sob `metadata:`), tolerante a indentacao, aspas e
 * comentario inline. Se qualquer linha declarar `type: feedback`, retorna
 * "feedback"; senao retorna o primeiro `type:` encontrado (ex: "project");
 * sem frontmatter/sem type -> undefined.
 */
function frontmatterType(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  let first;
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^\s*type:\s*["']?([A-Za-z_]+)["']?\s*(?:#.*)?$/);
    if (!lm) continue;
    const v = lm[1].toLowerCase();
    if (v === "feedback") return "feedback";
    if (first === undefined) first = v;
  }
  return first;
}

/**
 * Roteia um arquivo de memoria para "feedback" (pool compartilhado por autor)
 * ou "memoria" (memoria-de-caso do autor).
 *
 * Sinal PRIMARIO (spike CMR-138): o auto-memory nomeia arquivos livremente
 * (ex: `recursos-preferir-agravo.md`) e marca a categoria no frontmatter
 * (`metadata.type: feedback|project|reference`). O frontmatter e primario nos
 * DOIS sentidos: `type: feedback` -> "feedback"; type CONHECIDO nao-feedback
 * (`project`/`reference`/`user`) -> "memoria" MESMO com nome `feedback_*`. Sem
 * frontmatter ou type desconhecido -> FALLBACK legado por nome: prefixo
 * `feedback_` -> "feedback". Caso contrario -> "memoria".
 *
 * content ausente/nao-string -> so o fallback de prefixo.
 */
const MEMORIA_KNOWN_TYPES = new Set(["project", "reference", "user"]);

export function memFileType(name, content) {
  if (typeof content === "string") {
    const ft = frontmatterType(content);
    if (ft === "feedback") return "feedback";
    if (MEMORIA_KNOWN_TYPES.has(ft)) return "memoria";
  }
  if (typeof name === "string" && name.startsWith("feedback_")) return "feedback";
  return "memoria";
}

// ---------- CMR-138 (review adversarial): validacao de segmentos de path ----------
//
// O manifest de memoria/feedback e DADO REMOTO nao-confiavel; caso/autor/arquivo
// viram segmentos de path no disco do cliente. Sem guard, um autor forjado como
// `../../PWNED/x` faz `join(caseDir, autor)` escapar de casesBase e gravar arquivo
// arbitrario. O sync de briefing ja disciplina o nome de caso com VALID_CASE_NAME;
// estas helpers espelham essa disciplina nos 3 niveis da arvore de memoria e sao
// usadas em DUAS camadas (defense-in-depth): no plano (planMemoriaActions descarta
// com aviso) E no ponto de escrita (syncMemoria revalida, appendLog + skip).
const VALID_MEMORIA_AUTHOR = /^[A-Za-z0-9._-]+$/;

/** Caso seguro: VALID_CASE_NAME (mesmo do briefing) OU o pseudo-caso `.feedback`
 * (leading dot rejeitado por VALID_CASE_NAME -> precisa do OR explicito). */
export function isSafeMemoriaCase(caso) {
  return typeof caso === "string" && (VALID_CASE_NAME.test(caso) || caso === FEEDBACK_POOL);
}

/** Autor seguro: `^[A-Za-z0-9._-]+$` e nao `.`/`..` (ambos casam o regex mas
 * traversam). Sem `/`, `\` (fora do char class). */
export function isSafeMemoriaAuthor(author) {
  return (
    typeof author === "string" &&
    author !== "." &&
    author !== ".." &&
    VALID_MEMORIA_AUTHOR.test(author)
  );
}

/** Arquivo seguro: sem `/`, `\`, `..`; termina em `.md`; nao e artefato de
 * indice (`PEERS.md`/`FEEDBACK.md`). */
export function isSafeMemoriaFile(file) {
  return (
    typeof file === "string" &&
    !file.includes("/") &&
    !file.includes("\\") &&
    !file.includes("..") &&
    file.endsWith(".md") &&
    file !== "PEERS.md" &&
    file !== "FEEDBACK.md"
  );
}

/**
 * Decide download e upload da memoria de caso a partir do manifest remoto
 * (por-autor), do estado local e do baseline.
 *
 * Shapes (destripados do envelope pela Task 10):
 *   remoteManifest:     { <caso>: { <autor>: { <arquivo>: md5|{md5} } } }
 *   localMemoriaState:  { <caso>: { <autor>: { <arquivo>: md5|{md5,content} } } }
 *   baseline:           { <caso>: { <autor>: { <arquivo>: md5|{md5} } } }
 *   selfAuthor:         id do proprio autor (string) ou null
 *
 * Retorna:
 *   { downloadAuthors: [{ case, author, files: [nome] }],
 *     uploadFiles:     [{ case, name, content, target: "memoria"|"feedback" }],
 *     warnings:        [string] }
 *
 * DOWNLOAD (qualquer autor, peer OU self, sob never-overwrite): baixa um
 * arquivo quando
 *   - ausente local E ausente do baseline (nunca visto nesta maquina -> seed), OU
 *   - a VM mudou e o local ficou intocado desde o ultimo sync
 *     (baseMd5 definido, local === baseline, local !== VM).
 * Ausente local MAS presente no baseline = o usuario DELETOU localmente apos o
 * baseline -> PRESERVA a delecao (nao baixa): a auto-memory deleta memorias
 * erradas por design, ressuscita-las e nocivo. Edicao local divergente (inclui
 * bootstrap sem baseline) -> preserva. Espelha o never-overwrite de planActions.
 *
 * UPLOAD (SO o proprio autor): deriva EXCLUSIVAMENTE de
 * localMemoriaState[caso][selfAuthor] -- nunca dos subdirs de peers ja baixados
 * (senao re-uploadaria memoria alheia como se fosse sua). selfAuthor null ->
 * nenhum upload. Roteamento por memFileType (frontmatter, com fallback prefixo).
 * O GATE de "ja sincronizado" depende do DESTINO do roteamento (CMR-138):
 *   - target "memoria" (memoria-de-caso do autor): compara contra o remote do
 *     CASO (remoteManifest[caso][self][arq]); sobe quando a VM nao tem OU
 *     local !== VM E o arquivo NAO esta na fila de download deste plano (senao
 *     subir a local antiga por cima seria revert da versao mais nova da VM).
 *   - target "feedback" (pool compartilhado do escritorio): o arquivo vive
 *     fisicamente sob <caso>/.memoria/<self>/ mas remotamente vive no POOL
 *     (remoteManifest[".feedback"][self][arq]); o gate compara contra o POOL,
 *     nao contra o remote do caso (que NUNCA tem o arquivo -> remoteMd5 sempre
 *     undefined -> re-upload perpetuo a cada ciclo). Sobe quando o pool nao tem
 *     OU local !== pool. SEM consulta a downloadKeys aqui: o download do pool
 *     atualiza a COPIA em .feedback/<self>/, entidade distinta do original no
 *     caso -- nao ha revert possivel.
 * DEDUPE de colisao de nome no pool: o pool tem 1 slot por (autor, nome). Se 2+
 * casos reais tem um arquivo target-feedback com o MESMO nome, sobe SO o do caso
 * lexicograficamente MENOR (vencedor deterministico -> sem alternancia entre
 * ciclos: um perdedor NUNCA sobe, mesmo quando o vencedor esta barrado pelo
 * gate). Quando os md5 divergem (conflito real de conteudo), registra um aviso
 * legivel em `warnings`. O pseudo-caso ".feedback" (copias baixadas do pool) nao
 * participa da disputa -- cai no gate padrao (local == pool pos-seed -> barrado).
 */
export function planMemoriaActions(remoteManifest, localMemoriaState, baseline, selfAuthor) {
  const plan = { downloadAuthors: [], uploadFiles: [], warnings: [] };
  remoteManifest = remoteManifest || {};
  localMemoriaState = localMemoriaState || {};
  baseline = baseline || {};

  // Fila de download deste plano (chave `${caso} ${autor} ${arquivo}`) para o
  // gate de upload nao reverter uma versao da VM que este mesmo plano vai baixar.
  const downloadKeys = new Set();

  // ----- DOWNLOAD -----
  for (const [caso, authors] of Object.entries(remoteManifest)) {
    if (!authors || typeof authors !== "object") continue;
    // Camada 1 (defense-in-depth): nome de caso inseguro do manifest nunca vira
    // segmento de path no plano. Descarta com aviso legivel.
    if (!isSafeMemoriaCase(caso)) {
      plan.warnings.push(`download: caso com nome inseguro descartado: ${caso}`);
      continue;
    }
    for (const [author, files] of Object.entries(authors)) {
      if (!files || typeof files !== "object") continue;
      if (!isSafeMemoriaAuthor(author)) {
        plan.warnings.push(`download: autor com nome inseguro descartado em ${caso}: ${author}`);
        continue;
      }
      const localAuthor = localMemoriaState[caso]?.[author];
      const baseAuthor = baseline[caso]?.[author];
      const needs = [];
      for (const [file, info] of Object.entries(files)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        if (!isSafeMemoriaFile(file)) {
          plan.warnings.push(`download: arquivo com nome inseguro descartado em ${caso}/${author}: ${file}`);
          continue;
        }
        const vmMd5 = fileMd5(info);
        const localMd5 = fileMd5(localAuthor?.[file]);
        const baseMd5 = fileMd5(baseAuthor?.[file]);
        const seed = localMd5 === undefined && baseMd5 === undefined;
        const vmChangedUntouched =
          baseMd5 !== undefined && localMd5 === baseMd5 && localMd5 !== vmMd5;
        if (seed || vmChangedUntouched) {
          needs.push(file);
          downloadKeys.add(`${caso} ${author} ${file}`);
        }
        // ausente + baseline presente -> delecao local preservada;
        // divergente (edicao ou bootstrap sem baseline) -> preservado.
      }
      if (needs.length > 0) plan.downloadAuthors.push({ case: caso, author, files: needs });
    }
  }

  // ----- UPLOAD (so o proprio autor) -----
  if (selfAuthor !== null && selfAuthor !== undefined) {
    // Pool remoto de feedback (por-NOME, por-autor): destino de roteamento de
    // TODO arquivo target "feedback", independente do caso onde vive fisicamente.
    const feedbackPool = remoteManifest[FEEDBACK_POOL]?.[selfAuthor];

    // Pre-pass: vencedor por nome entre CASOS REAIS que tem um arquivo
    // target-feedback com aquele nome (exclui o pseudo-caso .feedback). O
    // vencedor deterministico (menor lexicografico) impede alternancia entre
    // ciclos; perdedores nunca sobem. Aviso so quando os md5 divergem (conflito).
    const fbNameToCases = new Map(); // nome -> [{ case, md5 }]
    for (const [caso, authors] of Object.entries(localMemoriaState)) {
      if (caso === FEEDBACK_POOL) continue;
      const selfFiles = authors?.[selfAuthor];
      if (!selfFiles || typeof selfFiles !== "object") continue;
      for (const [file, info] of Object.entries(selfFiles)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        if (memFileType(file, fileContent(info)) !== "feedback") continue;
        if (!fbNameToCases.has(file)) fbNameToCases.set(file, []);
        fbNameToCases.get(file).push({ case: caso, md5: fileMd5(info) });
      }
    }
    const fbWinner = new Map(); // nome -> caso vencedor (menor lexicografico)
    for (const [name, entries] of fbNameToCases) {
      let winner = entries[0].case;
      const md5s = new Set();
      for (const e of entries) {
        md5s.add(e.md5);
        if (e.case < winner) winner = e.case;
      }
      fbWinner.set(name, winner);
      if (entries.length > 1 && md5s.size > 1) {
        const casos = entries.map((e) => e.case).sort();
        const losers = casos.filter((c) => c !== winner);
        plan.warnings.push(
          `feedback ${name}: colisao de nome entre casos [${casos.join(", ")}] com conteudos distintos; ` +
            `subindo so ${winner} (menor), ignorando ${losers.join(", ")}`,
        );
      }
    }

    for (const [caso, authors] of Object.entries(localMemoriaState)) {
      const selfFiles = authors?.[selfAuthor];
      if (!selfFiles || typeof selfFiles !== "object") continue;
      for (const [file, info] of Object.entries(selfFiles)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        const localMd5 = fileMd5(info);
        const content = fileContent(info);
        const target = memFileType(file, content);

        let shouldUpload;
        if (target === "feedback") {
          // Colisao de nome no pool: perdedor nunca sobe (nem quando o vencedor
          // esta barrado pelo gate). O pseudo-caso .feedback nao entra em fbWinner.
          if (caso !== FEEDBACK_POOL && fbWinner.get(file) !== undefined && fbWinner.get(file) !== caso) {
            continue;
          }
          const remoteMd5 = fileMd5(feedbackPool?.[file]);
          shouldUpload = remoteMd5 === undefined || localMd5 !== remoteMd5;
        } else {
          const remoteSelf = remoteManifest[caso]?.[selfAuthor];
          const remoteMd5 = fileMd5(remoteSelf?.[file]);
          const queuedForDownload = downloadKeys.has(`${caso} ${selfAuthor} ${file}`);
          shouldUpload = remoteMd5 === undefined || (localMd5 !== remoteMd5 && !queuedForDownload);
        }

        if (shouldUpload) {
          // Camada 1: entrada com caso/arquivo inseguro nunca vira upload (o
          // caso vira segmento na URL; o nome vai no corpo do POST). selfAuthor
          // vem do JWT, nao do manifest -> nao entra nesta checagem.
          if (!isSafeMemoriaCase(caso) || !isSafeMemoriaFile(file)) {
            plan.warnings.push(`upload: entrada com nome inseguro descartada: ${caso}/${file}`);
            continue;
          }
          plan.uploadFiles.push({ case: caso, name: file, content, target });
        }
      }
    }
  }
  return plan;
}

/**
 * Novo baseline por-autor a persistir apos aplicar o plano de memoria. Analogo
 * a computeBaseline, sobre a arvore { <caso>: { <autor>: { <arquivo>: md5 } } }.
 *
 *   - Arquivo BAIXADO com sucesso (peer ou self) -> md5 da VM (agora local === VM).
 *   - Arquivo self UPLOADADO -> md5 LOCAL (a VM passou a te-lo). Sem isso o
 *     proximo ciclo veria o self recem-uploadado sem baseline e poderia
 *     re-baixar em ping-pong.
 *   - Arquivo ja sincronizado (local === VM) -> adota md5 da VM.
 *   - Conflito/falha -> mantem o baseline anterior.
 *   - Autor/caso ausente do manifest E nao uploadado -> removido (orfao).
 *
 * succeeded: Set de chaves `${caso} ${autor} ${arquivo}` baixadas com sucesso.
 * uploaded:  Set de chaves `${caso} ${selfAuthor} ${arquivo}` subidas com sucesso.
 */
export function computeMemoriaBaseline(remoteManifest, localMemoriaState, prevBaseline, succeeded, uploaded, selfAuthor) {
  remoteManifest = remoteManifest || {};
  localMemoriaState = localMemoriaState || {};
  prevBaseline = prevBaseline || {};
  succeeded = succeeded || new Set();
  uploaded = uploaded || new Set();

  const next = {};
  const put = (caso, author, file, md5) => {
    if (md5 === undefined) return;
    (next[caso] ??= {});
    (next[caso][author] ??= {});
    next[caso][author][file] = md5;
  };

  // Passo 1: espelha computeBaseline sobre a arvore por-autor da VM.
  for (const [caso, authors] of Object.entries(remoteManifest)) {
    if (!authors || typeof authors !== "object") continue;
    for (const [author, files] of Object.entries(authors)) {
      if (!files || typeof files !== "object") continue;
      const localAuthor = localMemoriaState[caso]?.[author];
      const prevAuthor = prevBaseline[caso]?.[author] ?? {};
      for (const [file, info] of Object.entries(files)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        const vmMd5 = fileMd5(info);
        const key = `${caso} ${author} ${file}`;
        if (succeeded.has(key)) {
          put(caso, author, file, vmMd5); // baixado -> agora igual a VM
        } else if (vmMd5 !== undefined && fileMd5(localAuthor?.[file]) === vmMd5) {
          put(caso, author, file, vmMd5); // ja sincronizado -> adota
        } else if (prevAuthor[file] !== undefined) {
          put(caso, author, file, fileMd5(prevAuthor[file])); // conflito/falha -> mantem
        }
      }
    }
  }

  // Passo 2: arquivos self UPLOADADOS -> md5 local (a VM passou a te-lo).
  if (selfAuthor !== null && selfAuthor !== undefined) {
    for (const [caso, authors] of Object.entries(localMemoriaState)) {
      const selfFiles = authors?.[selfAuthor];
      if (!selfFiles || typeof selfFiles !== "object") continue;
      for (const [file, info] of Object.entries(selfFiles)) {
        if (MEMORIA_IGNORED.has(file)) continue;
        if (uploaded.has(`${caso} ${selfAuthor} ${file}`)) put(caso, selfAuthor, file, fileMd5(info));
      }
    }
  }
  return next;
}

// Indices agregados (PEERS.md / FEEDBACK.md) sao ARTEFATOS do sync: o wiring
// (Task 10) os regera a partir do estado local e grava dentro de `.memoria`/
// `.feedback`. O CC le no maximo ~25 KB do MEMORY.md, entao os indices tem cap
// de 25 KB. Ao estourar, truncamos por ITEM INTEIRO (nunca corte no meio de um
// arquivo) e escrevemos um trailer VISIVEL com a contagem omitida.
const INDEX_MAX_BYTES = 25 * 1024;
// Folga reservada para o trailer; a contagem cabe com varios digitos.
const INDEX_TRAILER_RESERVE = 96;

function indexTrailer(n) {
  return `\n> [sync] ${n} itens omitidos por limite de tamanho\n`;
}

/**
 * Monta um indice agregado por-autor sobre `{ <autor>: { <arquivo>: {md5,content} } }`.
 * `header` e o texto de topo (explica a origem). Cada autor vira `## Autor <autor>`
 * e cada arquivo um bloco `### <nome>` seguido do conteudo. Anexa gulosamente por
 * byte ate o cap; itens que nao cabem sao contados e sinalizados no trailer. Pura.
 */
function buildAggregatedIndex(authorTrees, header) {
  authorTrees = authorTrees || {};
  const budget = INDEX_MAX_BYTES - INDEX_TRAILER_RESERVE;

  // Unidades de anexacao: cada arquivo e uma unidade; a primeira de cada autor
  // carrega o cabecalho do autor (assim um autor 100% omitido nao deixa header
  // solto). Ordenacao para saida deterministica.
  const units = [];
  for (const author of Object.keys(authorTrees).sort()) {
    const files = authorTrees[author];
    if (!files || typeof files !== "object") continue;
    let firstOfAuthor = true;
    for (const name of Object.keys(files).sort()) {
      const content = fileContent(files[name]) ?? "";
      let unit = "";
      if (firstOfAuthor) { unit += `## Autor ${author}\n\n`; firstOfAuthor = false; }
      unit += `### ${name}\n\n${content}\n\n`;
      units.push(unit);
    }
  }

  let out = header;
  let omitted = 0;
  let stopped = false;
  for (const unit of units) {
    if (stopped) { omitted++; continue; }
    if (Buffer.byteLength(out, "utf-8") + Buffer.byteLength(unit, "utf-8") <= budget) {
      out += unit;
    } else {
      // Trunca por item inteiro: para de anexar e conta o resto como omitido.
      stopped = true;
      omitted++;
    }
  }
  if (omitted > 0) out += indexTrailer(omitted);
  return out;
}

/**
 * Indice PEERS.md de um caso: memoria de caso dos OUTROS advogados sobre este
 * caso, agregada pelo sync. Input: `{ <autor>: { <arquivo>: {md5,content} } }`.
 */
export function buildPeersIndex(authorTrees) {
  const header =
    "# Memória de peers deste caso (agregada pelo sync)\n\n" +
    "Memória de caso de outros advogados do escritório sobre ESTE caso. " +
    "Somente leitura; o sync regenera este arquivo a cada ciclo.\n\n";
  return buildAggregatedIndex(authorTrees, header);
}

/**
 * Indice FEEDBACK.md do pool: feedback do escritório (aprendizados/correções)
 * agregado por autor pelo sync. Input: `{ <autor>: { <arquivo>: {md5,content} } }`.
 */
export function buildFeedbackIndex(authorTrees) {
  const header =
    "# Feedback do escritório (agregado pelo sync)\n\n" +
    "Aprendizados e correções compartilhados pelo escritório, agrupados por autor. " +
    "Somente leitura; o sync regenera este arquivo a cada ciclo.\n\n";
  return buildAggregatedIndex(authorTrees, header);
}

/**
 * Conteudo do <caso>/.claude/settings.local.json a provisionar, a partir do
 * settings.json do scaffolding (<casesBase>/.claude/settings.json). O CC NAO
 * herda settings de diretorio ancestral — a config que o scaffolding declara
 * para as sessoes de caso (outputStyle, permissions) fica inerte no pai e
 * cada caso nascia em default (selecao manual na primeira sessao). Retorna
 * a string JSON a gravar, ou null (sem scaffolding/sem outputStyle/JSON
 * invalido = no-op). So e gravado quando o arquivo NAO existe: depois do
 * nascimento ele pertence ao usuario/CC (mudar o style ou aprovar permissao
 * edita o mesmo arquivo; o sync nunca sobrescreve).
 */
export function buildLocalSettings(scaffoldingSettingsRaw, overrideStyle, autoMemoryDir) {
  if (typeof scaffoldingSettingsRaw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(scaffoldingSettingsRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.outputStyle !== "string") return null;
  const out = { outputStyle: overrideStyle || parsed.outputStyle };
  if (parsed.permissions !== undefined) out.permissions = parsed.permissions;
  // CMR-138: auto memory por-caso. So grava quando o caller passa um dir
  // (string nao-vazia); a normalizacao do path e do caller — aqui grava literal.
  if (typeof autoMemoryDir === "string" && autoMemoryDir) out.autoMemoryDirectory = autoMemoryDir;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Merge de `autoMemoryDirectory` num settings.local.json JA EXISTENTE (caso
 * legado, nascido antes do CMR-138). Round-trip preservando TODAS as chaves
 * (outputStyle, permissions, hooks, qualquer outra) — espelha a semantica de
 * setup.mjs:buildGlobalSettings (nao pisa em config alheia). Regras:
 *   - raw invalido/array/null/primitivo -> null (nao sobrescreve config corrompida)
 *   - raw que JA contem autoMemoryDirectory -> retorna o JSON inalterado
 *     (nunca sobrescreve escolha local do usuario)
 * O valor gravado e literal — a normalizacao do path (absoluto, `/` no Windows)
 * e responsabilidade do caller.
 */
export function mergeAutoMemoryDir(existingLocalRaw, autoMemoryDir) {
  if (typeof existingLocalRaw !== "string") return null;
  let obj;
  try {
    obj = JSON.parse(existingLocalRaw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.autoMemoryDirectory !== undefined) return `${JSON.stringify(obj, null, 2)}\n`;
  obj.autoMemoryDirectory = autoMemoryDir;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Extrai o override de output style do case.yaml do caso (campo opcional
 * `output_style: <nome>`, escrito na VM — a mao ou pelo classifier). O
 * case.yaml e formato NOSSO (materializado pelo case-ingest), entao um
 * match de linha basta — sem dependencia de parser YAML completo. Aceita
 * valor plano ou entre aspas; comentario inline (` # ...`) e descartado.
 */
export function extractOutputStyle(caseYamlRaw) {
  if (typeof caseYamlRaw !== "string") return null;
  const m = caseYamlRaw.match(/^output_style:[ \t]*(.+)$/m);
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.match(/^"([^"]*)"|^'([^']*)'/);
  if (quoted) {
    v = quoted[1] ?? quoted[2];
  } else {
    v = v.replace(/[ \t]+#.*$/, "").trim();
  }
  return v || null;
}

/**
 * Provisiona `<caso>/.claude/settings.local.json` para os casos do manifest
 * (CMR-138 injeta `autoMemoryDirectory` = `<casesBase>/<caso>/.memoria/<autor>`,
 * absoluto e normalizado para `/`). Cobre dois estados por caso:
 *   - NOVO (sem settings.local.json): cria a partir do scaffolding
 *     (outputStyle/permissions, override `output_style:` do case.yaml) +
 *     autoMemoryDirectory quando ha autor. Sem scaffolding valido -> nada a criar.
 *   - LEGADO (settings.local.json ja existe): injeta autoMemoryDirectory se
 *     ausente, preservando o resto (backup `.bak` + escrita atomica); ja com o
 *     campo OU byte-igual -> no-op sem backup; corrompido -> log e skip (nunca pisa).
 *
 * selfAuthor null/undefined -> pula a injecao inteira (sem subdir de autor): casos
 * novos nascem sem autoMemoryDirectory e legados ficam intocados; 1 log.
 * Nunca sobrescreve config existente (CMR-103). Erros por caso vao para `errors`.
 * Retorna a contagem de arquivos escritos. Extraida do main() para ser testavel
 * contra um tmpdir real sem rede.
 */
export function provisionCaseSettings(casesBase, manifestCases, localState, selfAuthor, errors) {
  let provisioned = 0;
  const scaffoldingSettings = join(casesBase, ".claude", "settings.json");
  const scaffoldingRaw = existsSync(scaffoldingSettings)
    ? readFileSync(scaffoldingSettings, "utf-8")
    : null;

  const hasAuthor = selfAuthor !== null && selfAuthor !== undefined;
  if (!hasAuthor) {
    appendLog(casesBase, "settings: autoMemoryDirectory nao injetado (sem autor)");
  }

  const localByLower = new Map(
    Object.keys(localState).map((k) => [k.toLowerCase(), k]),
  );
  for (const c of manifestCases) {
    if (!VALID_CASE_NAME.test(c.name) || isExcluded(c.name)) continue;
    const dirName = localByLower.get(c.name.toLowerCase()) ?? c.name;
    const caseDir = join(casesBase, dirName);
    if (!existsSync(caseDir)) continue;
    const target = join(caseDir, ".claude", "settings.local.json");
    // Path absoluto normalizado para `/` (no Windows casesBase vem com `\`).
    const autoMemoryDir = hasAuthor
      ? [casesBase, dirName, ".memoria", selfAuthor].join("/").replace(/\\/g, "/")
      : undefined;

    try {
      if (!existsSync(target)) {
        // Caso NOVO: cria settings.local.json (com autoMemoryDirectory se ha autor).
        const caseYamlPath = join(caseDir, "case.yaml");
        const overrideStyle = extractOutputStyle(
          existsSync(caseYamlPath) ? readFileSync(caseYamlPath, "utf-8") : null,
        );
        const localSettings = buildLocalSettings(scaffoldingRaw, overrideStyle, autoMemoryDir);
        if (!localSettings) continue; // sem scaffolding valido: nada a criar
        mkdirSync(join(caseDir, ".claude"), { recursive: true });
        writeAtomic(target, localSettings);
        provisioned++;
      } else if (autoMemoryDir) {
        // Caso LEGADO: injeta autoMemoryDirectory se ausente, preservando o resto.
        const existingRaw = readFileSync(target, "utf-8");
        const merged = mergeAutoMemoryDir(existingRaw, autoMemoryDir);
        if (merged === null) {
          appendLog(casesBase, `settings: ${dirName}/settings.local.json invalido -> injecao de autoMemoryDirectory pulada`);
          continue;
        }
        // byte-igual cobre "ja continha o campo" (merge devolve o canonico igual)
        // e "nada mudou" -> no-op sem backup. So grava (com backup) se de fato mudou.
        if (merged === existingRaw) continue;
        copyFileSync(target, `${target}.bak`);
        writeAtomic(target, merged);
        provisioned++;
      }
    } catch (err) {
      errors.push(`settings ${dirName}: ${err.message}`);
    }
  }
  return provisioned;
}

/** Nome de destino em _archive/, sufixando -YYYYMMDD em colisao. */
export function archiveTarget(name, taken, now = new Date()) {
  if (!taken.has(name)) return name;
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  const candidate = `${name}-${ymd}`;
  if (!taken.has(candidate)) return candidate;
  return `${name}-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
}

// ---------- I/O ----------

function readLocalState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  for (const entry of readdirSync(casesBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = {};
    for (const f of BRIEFING_FILES) {
      const p = join(casesBase, entry.name, f);
      if (existsSync(p)) files[f] = md5hex(readFileSync(p));
    }
    state[entry.name] = files;
  }
  return state;
}

/** Le os *.md de um dir de autor -> { <arquivo>: { md5, content } }, aplicando ignore. */
function readAuthorFiles(authorDir, ignored) {
  const files = {};
  for (const fileEntry of readdirSync(authorDir, { withFileTypes: true })) {
    if (!fileEntry.isFile()) continue;
    const name = fileEntry.name;
    if (ignored.has(name)) continue;
    if (!name.endsWith(".md")) continue;
    const buf = readFileSync(join(authorDir, name));
    files[name] = { md5: md5hex(buf), content: buf.toString("utf-8") };
  }
  return files;
}

/**
 * Le a arvore de memoria de caso local: `<casesBase>/<caso>/.memoria/<autor>/*.md`.
 * Retorna { <caso>: { <autor>: { <arquivo>: { md5, content } } } } (com content —
 * o upload do self e os indices precisam do conteudo). Ignora PEERS.md (artefato
 * do sync), entradas nao-dir, arquivos nao-.md e casos sem `.memoria`. Tolerante:
 * casesBase/dir ausente -> objeto vazio. md5 dos bytes crus, como readLocalState.
 */
export function readMemoriaState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  for (const caseEntry of readdirSync(casesBase, { withFileTypes: true })) {
    if (!caseEntry.isDirectory()) continue;
    const memDir = join(casesBase, caseEntry.name, ".memoria");
    if (!existsSync(memDir)) continue;
    const authors = {};
    for (const authorEntry of readdirSync(memDir, { withFileTypes: true })) {
      if (!authorEntry.isDirectory()) continue;
      const files = readAuthorFiles(join(memDir, authorEntry.name), MEMORIA_IGNORED);
      if (Object.keys(files).length > 0) authors[authorEntry.name] = files;
    }
    if (Object.keys(authors).length > 0) state[caseEntry.name] = authors;
  }
  return state;
}

/**
 * Le o pool de feedback do escritorio local: `<casesBase>/.feedback/<autor>/*.md`.
 * Retorna { <autor>: { <arquivo>: { md5, content } } }. Ignora FEEDBACK.md (indice
 * na raiz de `.feedback/` — cai fora por nao ser dir; ignorado defensivamente em
 * qualquer nivel), entradas nao-dir e arquivos nao-.md. Tolerante: `.feedback`
 * ausente -> objeto vazio.
 */
export function readFeedbackState(casesBase) {
  const state = {};
  if (!existsSync(casesBase)) return state;
  const feedbackDir = join(casesBase, ".feedback");
  if (!existsSync(feedbackDir)) return state;
  for (const authorEntry of readdirSync(feedbackDir, { withFileTypes: true })) {
    if (!authorEntry.isDirectory()) continue; // FEEDBACK.md na raiz cai aqui (nao-dir)
    const files = readAuthorFiles(join(feedbackDir, authorEntry.name), FEEDBACK_IGNORED);
    if (Object.keys(files).length > 0) state[authorEntry.name] = files;
  }
  return state;
}

/** Escrita atomica: tmp + rename (rename sobrescreve no Windows via MoveFileEx). */
function writeAtomic(path, content) {
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

const STATE_FILE = ".sync-state.json";

export function readBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {}; // estado corrompido: trata como bootstrap, nao derruba o sync
  }
}

function writeBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

async function fetchJson(url) {
  // Bearer S2S via requestWithAuth: injeta Authorization quando ha credencial
  // (login do plugin), faz refresh em 401, e DEGRADA sem credencial (segue sem
  // Bearer -- preserva o uso atual na tailnet com require_bearer=false). Mesma
  // credencial do MCP (keychain), entao o sync herda o login sem passo extra.
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(10_000) }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return await res.json();
}

/**
 * POST autenticado espelhando fetchJson: Bearer S2S via requestWithAuth (injeta
 * quando ha credencial, refresh em 401, degrada sem credencial), timeout 10s,
 * lanca em nao-ok. Body JSON. Retorna a resposta parseada. Usado no upload de
 * memoria/feedback (CMR-138).
 */
export async function postJson(url, body) {
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return await res.json();
}

/**
 * GET autenticado que devolve os BYTES CRUS (Buffer). O download de workdoc
 * serve o arquivo em si, não JSON — e o md5 do baseline é dos bytes crus, então
 * o conteúdo nunca pode passar por decode/encode de texto. Mesmo Bearer e
 * degrade do fetchJson; timeout maior (arquivo de até 2 MiB).
 */
export async function fetchBytes(url) {
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(20_000) }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function appendLog(casesBase, line) {
  try {
    appendFileSync(join(casesBase, ".sync.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // log nunca derruba o sync
  }
}

// ---------- CMR-138: wiring do sync de memoria de caso (Task 10) ----------
//
// Liga as puras (planMemoriaActions/computeMemoriaBaseline + read*State +
// build*Index) a rede e disco. Estado SEPARADO em .memoria-state.json — a
// invariante dos 3 briefing files (.sync-state.json etc) e INTOCAVEL. Toda
// falha de I/O/rede loga e continua; nenhum caminho aqui pode derrubar o sync
// de briefing (main chama em try/catch proprio).

// Estado do sync de memoria — arquivo PROPRIO, distinto de .sync-state.json.
const STATE_FILE_MEMORIA = ".memoria-state.json";

// Pseudo-caso do pool de feedback nas estruturas de plano/baseline: um unico
// mapa combinado {...casosReais, ".feedback": authorsDoPool} passa por
// planMemoriaActions/computeMemoriaBaseline como se fosse mais um caso. Nunca
// colide com caso real (o server rejeita nome com leading dot).
const FEEDBACK_POOL = ".feedback";

// Caps de upload — espelham o servidor: 50 arquivos/req, 1 MiB/arquivo, 5 MiB/req.
const UPLOAD_MAX_FILES = 50;
const UPLOAD_MAX_FILE_BYTES = 1024 * 1024;
const UPLOAD_MAX_REQ_BYTES = 5 * 1024 * 1024;
// Folga por arquivo p/ o envelope JSON ({"files":[{"name","content"}]} + escaping):
// orcamos sobre content+name para nunca estourar o limite de body do server.
const UPLOAD_ENVELOPE_RESERVE = 64;

function readMemoriaBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE_MEMORIA);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {}; // estado corrompido: trata como bootstrap, nao derruba o sync
  }
}

function writeMemoriaBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE_MEMORIA);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

/**
 * Agrupa arquivos de upload em batches respeitando os caps do servidor:
 * <=UPLOAD_MAX_FILES por batch e custo (content+name+envelope) <=UPLOAD_MAX_REQ_BYTES.
 * Arquivos sem content string ou acima de UPLOAD_MAX_FILE_BYTES sao pulados
 * (reportados em `skipped`, nunca derrubam o batch). Pura.
 * Retorna { batches: [[file]], skipped: [{ name, case, reason }] }.
 */
function batchUploads(files) {
  const batches = [];
  const skipped = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (typeof f.content !== "string") {
      skipped.push({ name: f.name, case: f.case, reason: "sem conteudo" });
      continue;
    }
    const contentBytes = Buffer.byteLength(f.content, "utf-8");
    if (contentBytes > UPLOAD_MAX_FILE_BYTES) {
      skipped.push({ name: f.name, case: f.case, reason: ">1MiB" });
      continue;
    }
    const cost = contentBytes + Buffer.byteLength(f.name, "utf-8") + UPLOAD_ENVELOPE_RESERVE;
    if (cur.length >= UPLOAD_MAX_FILES || (cur.length > 0 && curBytes + cost > UPLOAD_MAX_REQ_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return { batches, skipped };
}

// ---------- Migracao dos dirs de autor para slug legivel (author_dir) ----------
//
// Ate 07/2026 o subdir de autor era o `sub` numerico do JWT ("1", "6"). O server
// passou a emitir/gravar um slug legivel (`pedro-giudice`) e os manifests trazem
// `aliases: { "<sub>": "<slug>" }` — o mapa que DIRIGE a migracao local, sem
// heuristica. Esta migracao roda no inicio de cada ciclo de memoria; e idempotente
// (2a rodada = no-op, porque os dirs antigos ja nao existem).

// Dir de autor migravel: espelha `isSafeMemoriaAuthor` e ADICIONA a recusa de
// ponto inicial (dir oculto / colisao com o pseudo-caso `.feedback` nao e autor).
// Mesma regra do `decodeJwtAuthorDir` (auth.mjs).
const MIGRATABLE_AUTHOR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isMigratableAuthor(v) {
  return typeof v === "string" && MIGRATABLE_AUTHOR.test(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Regrava `autoMemoryDirectory` de um `settings.local.json` SOMENTE quando o
 * valor atual termina no sufixo EXATO `/.memoria/<oldDir>` (comparacao de string,
 * sem heuristica: `.../.memoria/11` NAO casa com oldDir `1`). Qualquer outro
 * valor — apontando pra fora, ja migrado, ausente — fica intocado.
 *
 * Nao viola o espirito never-overwrite (CMR-103): so troca o valor que NOS mesmos
 * provisionamos, casado por igualdade exata, preservando todas as outras chaves;
 * backup `.bak` + escrita atomica. Arquivo ausente/corrompido/sem o campo -> false
 * sem tocar em nada. Retorna true se regravou.
 */
export function updateAutoMemoryDirIfAliased(settingsPath, oldDir, newDir) {
  if (!isMigratableAuthor(oldDir) || !isMigratableAuthor(newDir)) return false;
  if (!existsSync(settingsPath)) return false;
  let obj;
  try {
    obj = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return false; // corrompido: nunca pisa
  }
  if (!isPlainObject(obj)) return false;
  const cur = obj.autoMemoryDirectory;
  if (typeof cur !== "string") return false;
  if (!cur.endsWith(`/.memoria/${oldDir}`)) return false;
  obj.autoMemoryDirectory = `${cur.slice(0, cur.length - oldDir.length)}${newDir}`;
  try {
    copyFileSync(settingsPath, `${settingsPath}.bak`);
    writeAtomic(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
  } catch {
    return false;
  }
  return true;
}

/**
 * Migra os dirs de autor locais de `<sub>` para `<slug>`, dirigido pelos
 * `aliases` do manifest. Tres efeitos, todos idempotentes:
 *
 *  (a) DISCO: para cada (oldDir -> newDir) com `<caso>/.memoria/<oldDir>` (ou
 *      `.feedback/<oldDir>`) presente: rename quando o destino nao existe; senao
 *      MERGE CONSERVADOR — move os arquivos ausentes no destino; duplicata
 *      byte-identica (md5 igual, estado tipico da janela do rename no server) e
 *      removida da origem porque o conteudo ja esta intacto no destino; e
 *      divergencia real PRESERVA o destino e mantem o arquivo no dir velho
 *      (reportada em `conflicts`). Nunca sobrescreve, nunca perde conteudo; o
 *      dir velho so e removido quando fica vazio.
 *  (b) BASELINE: devolve `baseline` com as chaves de autor reescritas (casos reais
 *      e pseudo-caso `.feedback`); o destino ja existente vence na fusao. O input
 *      NAO e mutado — o caller grava.
 *  (c) SETTINGS: `<caso>/.claude/settings.local.json` com `autoMemoryDirectory`
 *      terminando no sufixo exato do dir antigo e reapontado (ver
 *      `updateAutoMemoryDirIfAliased`).
 *
 * NAO depende de `selfAuthor`: dirs de PEERS (cujo par o proprio JWT nao carrega)
 * migram igual, e o mapa vem do manifest. Nunca lanca — falhas por par vao para
 * `errors` e o ciclo segue.
 *
 * Retorna { renames, conflicts, settings, errors, baseline, changed }.
 */
export function migrateAuthorDirs(casesBase, aliases, state) {
  const out = { renames: [], conflicts: [], settings: [], errors: [], baseline: state, changed: false };

  const pairs = [];
  if (isPlainObject(aliases)) {
    for (const [oldDir, newDir] of Object.entries(aliases)) {
      if (!isMigratableAuthor(oldDir) || !isMigratableAuthor(newDir)) continue;
      if (oldDir === newDir) continue;
      pairs.push([oldDir, newDir]);
    }
  }
  if (pairs.length === 0) {
    out.baseline = isPlainObject(state) ? state : {};
    return out;
  }
  const aliasOf = new Map(pairs);

  // (b) baseline rekeyed (em memoria; o caller grava).
  const src = isPlainObject(state) ? state : {};
  const baseline = {};
  let rekeyed = false;
  for (const [caso, authors] of Object.entries(src)) {
    if (!isPlainObject(authors)) {
      baseline[caso] = authors;
      continue;
    }
    const next = {};
    for (const [author, files] of Object.entries(authors)) {
      if (!aliasOf.has(author)) next[author] = files;
    }
    for (const [author, files] of Object.entries(authors)) {
      if (!aliasOf.has(author)) continue;
      const to = aliasOf.get(author);
      rekeyed = true;
      // destino ja existente VENCE (mesma regra do merge em disco)
      next[to] = { ...(isPlainObject(files) ? files : {}), ...(isPlainObject(next[to]) ? next[to] : {}) };
    }
    baseline[caso] = next;
  }
  out.baseline = baseline;

  // (a)+(c) disco e settings, por caso local (pseudo-caso `.feedback` incluso).
  let entries = [];
  try {
    entries = existsSync(casesBase) ? readdirSync(casesBase, { withFileTypes: true }) : [];
  } catch (err) {
    out.errors.push(`listando ${casesBase}: ${err.message}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_archive") continue;
    const isPool = entry.name === FEEDBACK_POOL;
    if (!isPool && entry.name.startsWith(".")) continue; // .claude e afins
    const caso = entry.name;
    const memDir = isPool ? join(casesBase, FEEDBACK_POOL) : join(casesBase, caso, ".memoria");

    for (const [oldDir, newDir] of pairs) {
      // (a) disco
      const from = join(memDir, oldDir);
      if (existsSync(memDir) && existsSync(from)) {
        const to = join(memDir, newDir);
        try {
          if (!existsSync(to)) {
            renameSync(from, to);
            out.renames.push({ case: caso, from: oldDir, to: newDir, mode: "rename" });
          } else {
            for (const f of readdirSync(from, { withFileTypes: true })) {
              if (!f.isFile()) continue;
              const src = join(from, f.name);
              const dst = join(to, f.name);
              if (existsSync(dst)) {
                // Duplicata byte-identica (estado tipico da janela do rename no
                // server: o dir novo foi baixado como peer enquanto o antigo
                // seguia no disco) -> remove a copia da origem. Nada se perde:
                // o conteudo continua intacto no destino. Divergencia real ->
                // conflito: destino preservado E arquivo mantido no dir antigo.
                if (md5hex(readFileSync(src)) === md5hex(readFileSync(dst))) {
                  unlinkSync(src);
                  continue;
                }
                out.conflicts.push({ case: caso, from: oldDir, to: newDir, file: f.name });
                continue;
              }
              renameSync(src, dst);
            }
            // so remove o dir velho se ficou vazio (nada e destruido)
            if (readdirSync(from).length === 0) rmdirSync(from);
            out.renames.push({ case: caso, from: oldDir, to: newDir, mode: "merge" });
          }
        } catch (err) {
          out.errors.push(`migrando ${caso}/${oldDir} -> ${newDir}: ${err.message}`);
        }
      }

      // (c) settings (o pool nao tem .claude/)
      if (isPool) continue;
      try {
        const settingsPath = join(casesBase, caso, ".claude", "settings.local.json");
        if (updateAutoMemoryDirIfAliased(settingsPath, oldDir, newDir)) {
          out.settings.push({ case: caso, from: oldDir, to: newDir });
        }
      } catch (err) {
        out.errors.push(`settings ${caso} (${oldDir} -> ${newDir}): ${err.message}`);
      }
    }
  }

  out.changed = rekeyed || out.renames.length > 0 || out.settings.length > 0;
  return out;
}

/**
 * Sincroniza a memoria de caso por-autor: baixa peers (+ self sob never-overwrite)
 * e sobe SO os arquivos do proprio autor, roteados p/ memoria-de-caso ou pool de
 * feedback. Orquestra as puras da Task 8/9. `deps` injeta a rede em teste
 * (getJson/postJson); default usa as reais (fetchJson/postJson). NUNCA lanca —
 * toda falha loga e continua. selfAuthor null/undefined -> skip total.
 *
 * Contratos do servidor:
 *   GET  /memoria-manifest   -> { cases: { <caso>: { <autor>: { <arq>: md5 } } } }
 *   GET  /feedback-manifest  -> { authors: { <autor>: { <arq>: md5 } } }
 *   GET  /cases/{c}/memoria/{a} e /feedback/{a} -> { files: { <arq>: {content,md5} } }
 *   POST /cases/{c}/memoria e /feedback -> body { files: [{name,content}] };
 *        resp { author, count, written: [nome], case? }
 */
export async function syncMemoria(apiBase, casesBase, selfAuthor, deps = {}) {
  const doGet = deps.getJson || fetchJson;
  const doPost = deps.postJson || postJson;

  // 1) Dois GETs fixos por ciclo (manifests agregados). Falha -> skip com log.
  // ANTES do gate de autor: e dos manifests que vem `aliases`, que dirige a
  // migracao dos dirs de autor (inclusive de PEERS, cujo par o JWT nao carrega).
  let memManifest, fbManifest;
  try {
    memManifest = await doGet(`${apiBase}/memoria-manifest`);
    fbManifest = await doGet(`${apiBase}/feedback-manifest`);
  } catch (err) {
    appendLog(casesBase, `memoria: erro manifest: ${err.message}`);
    return;
  }

  // 1b) Migracao <sub> -> <slug> dirigida pelos aliases. Idempotente, no-op quando
  // nao ha dir antigo. Roda ANTES de ler o estado local (o plano tem que ver o
  // disco ja migrado) e INDEPENDE de selfAuthor.
  try {
    const aliases = { ...(fbManifest?.aliases || {}), ...(memManifest?.aliases || {}) };
    const prevBaseline = readMemoriaBaselineFrom(casesBase);
    const mig = migrateAuthorDirs(casesBase, aliases, prevBaseline);
    for (const r of mig.renames) {
      appendLog(casesBase, `memoria: migracao de autor ${r.case}: ${r.from} -> ${r.to} (${r.mode})`);
    }
    for (const c of mig.conflicts) {
      appendLog(casesBase, `memoria: migracao ${c.case}: ${c.from}/${c.file} ja existe em ${c.to} -> destino preservado, arquivo mantido no dir antigo`);
    }
    for (const s of mig.settings) {
      appendLog(casesBase, `memoria: migracao settings ${s.case}: autoMemoryDirectory ${s.from} -> ${s.to}`);
    }
    for (const e of mig.errors) {
      appendLog(casesBase, `memoria: erro na migracao de autor: ${e}`);
    }
    // Persiste o baseline rekeyed ja aqui: se o ciclo parar adiante (sem autor),
    // a migracao nao se perde nem re-dispara no proximo ciclo.
    if (mig.changed) writeMemoriaBaseline(casesBase, mig.baseline);
  } catch (err) {
    appendLog(casesBase, `memoria: erro na migracao de autor: ${err.message}`);
  }

  if (selfAuthor === null || selfAuthor === undefined) {
    appendLog(casesBase, "memoria: sem autor (credencial ausente/sem sub) -> skip");
    return;
  }

  const remoteCombined = {
    ...(memManifest?.cases || {}),
    [FEEDBACK_POOL]: fbManifest?.authors || {},
  };

  // 2) Estado local + baseline combinados (pool como pseudo-caso).
  let memoriaState = {}, feedbackState = {}, baseline = {};
  try {
    memoriaState = readMemoriaState(casesBase);
    feedbackState = readFeedbackState(casesBase);
    baseline = readMemoriaBaselineFrom(casesBase);
  } catch (err) {
    appendLog(casesBase, `memoria: erro lendo estado local: ${err.message}`);
    return;
  }
  const localCombined = { ...memoriaState, [FEEDBACK_POOL]: feedbackState };

  const plan = planMemoriaActions(remoteCombined, localCombined, baseline, selfAuthor);

  // Avisos do plano (ex: colisao de nome no pool de feedback entre casos) -> log.
  for (const w of plan.warnings) {
    appendLog(casesBase, `memoria: aviso: ${w}`);
  }

  // 3+4) Downloads: so casos com dir local (pool sempre elegivel). Escrita atomica
  // em <caso>/.memoria/<autor>/ ou .feedback/<autor>/. Chave de sucesso combina
  // com computeMemoriaBaseline (`${caso} ${autor} ${arquivo}`, caso=".feedback" no pool).
  const succeeded = new Set();
  let downloaded = 0;
  for (const d of plan.downloadAuthors) {
    // Camada 2 (fail-safe): revalida os segmentos imediatamente antes de qualquer
    // mkdir/escrita. Redundante com a camada 1 por design (defense-in-depth) --
    // um caso/autor inseguro que escapasse do plano nunca vira path no disco.
    if (!isSafeMemoriaCase(d.case) || !isSafeMemoriaAuthor(d.author)) {
      appendLog(casesBase, `memoria: segmento inseguro no plano (caso=${d.case} autor=${d.author}) -> skip download`);
      continue;
    }
    const isPool = d.case === FEEDBACK_POOL;
    const caseDir = isPool ? join(casesBase, FEEDBACK_POOL) : join(casesBase, d.case);
    if (!isPool && !existsSync(caseDir)) {
      appendLog(casesBase, `memoria: caso ${d.case} sem dir local -> skip download`);
      continue;
    }
    const authorDir = isPool ? join(caseDir, d.author) : join(caseDir, ".memoria", d.author);
    let payload;
    try {
      const path = isPool
        ? `${apiBase}/feedback/${encodeURIComponent(d.author)}`
        : `${apiBase}/cases/${encodeURIComponent(d.case)}/memoria/${encodeURIComponent(d.author)}`;
      payload = await doGet(path);
    } catch (err) {
      appendLog(casesBase, `memoria: erro baixando ${d.case}/${d.author}: ${err.message}`);
      continue;
    }
    try {
      mkdirSync(authorDir, { recursive: true });
    } catch (err) {
      appendLog(casesBase, `memoria: erro mkdir ${authorDir}: ${err.message}`);
      continue;
    }
    for (const file of d.files) {
      // Camada 2 (fail-safe): nome de arquivo inseguro nunca vira escrita.
      if (!isSafeMemoriaFile(file)) {
        appendLog(casesBase, `memoria: arquivo inseguro no plano ${d.case}/${d.author}/${file} -> skip`);
        continue;
      }
      const remote = payload?.files?.[file];
      if (!remote || typeof remote.content !== "string") continue; // sumiu entre manifest e fetch
      try {
        writeAtomic(join(authorDir, file), remote.content);
        succeeded.add(`${d.case} ${d.author} ${file}`);
        downloaded++;
      } catch (err) {
        appendLog(casesBase, `memoria: erro escrevendo ${d.case}/${d.author}/${file}: ${err.message}`);
      }
    }
  }

  // 5) Indices agregados a partir do estado POS-download (reflete o disco real).
  let postMem = {}, postFb = {};
  try { postMem = readMemoriaState(casesBase); } catch { /* index degrada p/ vazio */ }
  try { postFb = readFeedbackState(casesBase); } catch { /* idem */ }

  // PEERS.md por caso: autores do caso EXCLUINDO o self; so escreve se ha >=1 peer com arquivo.
  for (const [caso, authors] of Object.entries(postMem)) {
    const peerTrees = {};
    for (const [author, files] of Object.entries(authors)) {
      if (author === selfAuthor) continue;
      if (files && Object.keys(files).length > 0) peerTrees[author] = files;
    }
    if (Object.keys(peerTrees).length === 0) continue;
    try {
      const memDir = join(casesBase, caso, ".memoria");
      mkdirSync(memDir, { recursive: true });
      writeAtomic(join(memDir, "PEERS.md"), buildPeersIndex(peerTrees));
    } catch (err) {
      appendLog(casesBase, `memoria: erro PEERS.md ${caso}: ${err.message}`);
    }
  }

  // FEEDBACK.md do pool: TODOS os autores do pool (inclui self). So se ha pool.
  if (Object.keys(postFb).length > 0) {
    try {
      const fbDir = join(casesBase, FEEDBACK_POOL);
      mkdirSync(fbDir, { recursive: true });
      writeAtomic(join(fbDir, "FEEDBACK.md"), buildFeedbackIndex(postFb));
    } catch (err) {
      appendLog(casesBase, `memoria: erro FEEDBACK.md: ${err.message}`);
    }
  }

  // 6) Uploads roteados por target (never-overwrite decidido pela pura): target
  // "feedback" -> POST /feedback (case ignorado no server); "memoria" -> POST por
  // caso. `uploaded` chaveia por u.case (verbatim) p/ casar computeMemoriaBaseline.
  const uploaded = new Set();
  let uploadedCount = 0;
  const feedbackFiles = plan.uploadFiles.filter((u) => u.target === "feedback");
  const memoriaByCase = new Map();
  for (const u of plan.uploadFiles) {
    if (u.target === "feedback") continue;
    // target "memoria" com caso invalido (pseudo-caso/leading dot) nunca vira POST
    // de caso — o server rejeitaria; pula com log (defensivo, nao ocorre no fluxo real).
    if (typeof u.case !== "string" || u.case.startsWith(".")) {
      appendLog(casesBase, `memoria: upload memoria com caso invalido ${u.case}/${u.name} -> skip`);
      continue;
    }
    if (!memoriaByCase.has(u.case)) memoriaByCase.set(u.case, []);
    memoriaByCase.get(u.case).push(u);
  }

  // Posta batches de uma lista e coleta o `written` do server (so o ACEITO vira baseline).
  const postBatches = async (files, url, label) => {
    const { batches, skipped } = batchUploads(files);
    for (const s of skipped) {
      appendLog(casesBase, `memoria: upload pulado (${label}) ${s.name}: ${s.reason}`);
    }
    for (const batch of batches) {
      try {
        const resp = await doPost(url, { files: batch.map((f) => ({ name: f.name, content: f.content })) });
        const written = new Set(Array.isArray(resp?.written) ? resp.written : []);
        for (const f of batch) {
          if (written.has(f.name)) {
            uploaded.add(`${f.case} ${selfAuthor} ${f.name}`);
            uploadedCount++;
          }
        }
      } catch (err) {
        appendLog(casesBase, `memoria: erro upload (${label}): ${err.message}`);
      }
    }
  };

  await postBatches(feedbackFiles, `${apiBase}/feedback`, "feedback");
  for (const [caso, files] of memoriaByCase) {
    await postBatches(files, `${apiBase}/cases/${encodeURIComponent(caso)}/memoria`, `memoria ${caso}`);
  }

  // 7) Baseline combinado (inclui o pseudo-caso .feedback). NUNCA toca .sync-state.json.
  try {
    const next = computeMemoriaBaseline(remoteCombined, localCombined, baseline, succeeded, uploaded, selfAuthor);
    writeMemoriaBaseline(casesBase, next);
  } catch (err) {
    appendLog(casesBase, `memoria: erro baseline: ${err.message}`);
  }

  appendLog(casesBase, `memoria: ok baixados=${downloaded} uploads=${uploadedCount}`);
}

// ---------- CMR-161: sync de workdocs do caso (pool comum de .md/.py) ----------
//
// Espelha os documentos de trabalho da pasta do caso (pesquisas .md, scripts de
// geração .py) entre as máquinas do escritório. Pool COMUM: mesmo path em todas,
// qualquer um evolui o arquivo do outro. A decisão é pura (workdocs.mjs); aqui
// mora o I/O.
//
// Invariantes:
//  - Estado PRÓPRIO em `.workdocs-state.json`. Não usa um namespace dentro de
//    `.sync-state.json` porque `computeBaseline` RECONSTRÓI aquele objeto do zero
//    a cada tick (só com os casos do manifest de briefing) -- uma chave irmã seria
//    apagada no ciclo seguinte. Mesmo padrão de `.memoria-state.json`.
//  - O espelho NUNCA destrói: conflito preserva o local intacto e materializa o
//    remoto ao lado; deleção (local ou remota) não propaga na v1.
//  - Nada aqui pode derrubar o sync de briefing: toda falha vira linha de log.

const STATE_FILE_WORKDOCS = ".workdocs-state.json";

// Teto de downloads por ciclo: a tarefa do Windows tem ExecutionTimeLimit de
// 5 min e um seed grande não pode monopolizar o tick. O resto vai no próximo.
const WORKDOC_MAX_TICK_DOWNLOADS = 200;

// Tentativas de sufixo numérico quando o arquivo de conflito já existe com
// OUTRO conteúdo (segundo conflito no mesmo arquivo antes da reconciliação).
const CONFLICT_MAX_PROBES = 20;

function readWorkdocsBaselineFrom(casesBase) {
  const p = join(casesBase, STATE_FILE_WORKDOCS);
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {}; // estado corrompido: trata como bootstrap, não derruba o sync
  }
}

function writeWorkdocsBaseline(casesBase, baseline) {
  const path = join(casesBase, STATE_FILE_WORKDOCS);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(baseline), "utf-8");
  renameSync(tmp, path);
}

/**
 * Varre a pasta de um caso e devolve os workdocs locais:
 * `{ <path relativo com />: { md5, size } }` para o que o canal transporta e
 * `{ motivo, size? }` (SEM md5) para o que EXISTE no disco mas o canal não
 * transporta — acima do teto, ilegível (EACCES, lock de editor no Windows) ou
 * não-regular (symlink).
 *
 * A distinção CHAVE PRESENTE vs CHAVE AUSENTE é a invariante do canal:
 * descartar a entrada faria o planejador ler "não existe local" e emitir
 * download — SOBRESCREVENDO trabalho local. Toda dúvida sobre o arquivo vira
 * chave presente e inerte; só o que de fato não está no disco fica ausente.
 *
 * Poda dot-dirs e os diretórios de `WORKDOC_EXCLUDED_DIRS` (autos do pipeline e
 * árvores de dependência) em QUALQUER nível e SEM CAIXA, e para na profundidade
 * máxima — tudo espelhando o walk do servidor. `isWorkdocPath` é a autoridade
 * final por arquivo. O tamanho vem do `stat`: só o que é elegível é LIDO (ler
 * antes de medir poria centenas de MB na RAM a cada tick).
 * Tolerante: dir ausente/ilegível -> objeto vazio.
 */
export function readCaseWorkdocs(caseDir, maxFileBytes = WORKDOC_MAX_FILE_BYTES) {
  const out = {};
  if (!existsSync(caseDir)) return out;
  const walk = (dir, prefix, depth) => {
    if (depth > WORKDOC_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue;
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!isWorkdocPath(rel)) continue;
      if (!entry.isFile()) {
        // Symlink (ou socket/fifo): o dirent não segue o link. Não transporta —
        // mas EXISTE no path, então nunca pode virar destino de download.
        out[rel] = { motivo: "não é arquivo regular (symlink ou especial)" };
        continue;
      }
      try {
        const size = statSync(abs).size;
        if (size > maxFileBytes) {
          out[rel] = { motivo: "acima de 2 MiB (teto por arquivo)", size };
          continue;
        }
        out[rel] = { md5: md5hex(readFileSync(abs)), size };
      } catch (err) {
        out[rel] = { motivo: `ilegível (${err.code || err.message})` };
      }
    }
  };
  walk(caseDir, "", 0);
  return out;
}

/**
 * Fase de workdocs do tick. Espelha a assinatura de `syncMemoria`.
 *
 * Contratos do servidor:
 *   GET  /workdocs-manifest -> { cases: { <caso>: { <path>: { md5 } } } }
 *   GET  /cases/{c}/workdocs/file?path=<rel> -> bytes crus do arquivo
 *   POST /cases/{c}/workdocs -> body { files: [{ path, content(base64) }] };
 *        resp { ok, written, failed: [{ path, reason }] }
 *
 * Nunca lança: toda falha (rede, disco, plano) vira linha em `.sync.log`.
 */
export async function syncWorkdocs(apiBase, casesBase, selfAuthor, deps = {}) {
  const doGet = deps.getJson || fetchJson;
  const doGetBytes = deps.getBytes || fetchBytes;
  const doPost = deps.postJson || postJson;

  // Sem autor não há como nomear o arquivo de conflito nem autenticar o
  // write-path (Bearer obrigatório) — o canal inteiro fica de fora do ciclo.
  if (selfAuthor === null || selfAuthor === undefined) {
    appendLog(casesBase, "workdocs: sem autor (credencial ausente/sem claim) -> skip");
    return;
  }

  let manifest;
  try {
    manifest = await doGet(`${apiBase}/workdocs-manifest`);
  } catch (err) {
    appendLog(casesBase, `workdocs: erro manifest: ${err.message}`);
    return;
  }
  const remoteCases = (manifest && typeof manifest.cases === "object" && manifest.cases) || {};

  let baseline = {};
  let briefingBaseline = {};
  try {
    baseline = readWorkdocsBaselineFrom(casesBase);
    briefingBaseline = readBaselineFrom(casesBase);
  } catch (err) {
    appendLog(casesBase, `workdocs: erro lendo estado local: ${err.message}`);
    return;
  }

  // Casos elegíveis: os que o servidor conhece (manifest) mais os que o espelho
  // de briefing já trouxe (bootstrap: caso sem nenhum workdoc na VM ainda). Dir
  // local que o espelho NUNCA trouxe é trabalho pessoal do usuário (CMR-104) —
  // o canal não o varre nem sobe nada de lá.
  const casos = [...new Set([...Object.keys(remoteCases), ...Object.keys(briefingBaseline)])]
    .filter((c) => VALID_CASE_NAME.test(c) && !isExcluded(c))
    .filter((c) => existsSync(join(casesBase, c)))
    .sort();

  const registros = [];
  const uploadCandidatos = [];
  let orcamentoDownload = WORKDOC_MAX_TICK_DOWNLOADS;
  let baixados = 0;
  let conflitos = 0;
  let erros = 0;

  // Baixa `relOrigem` do caso e grava em `relDestino` (iguais no download; no
  // conflito o destino é a cópia `.conflito-`, que NÃO é workdoc elegível e por
  // isso só passa pelos guards de path, não pela allowlist). Revalida os
  // segmentos imediatamente antes da escrita (camada 2, defense-in-depth: dado
  // remoto nunca vira caminho arbitrário). Devolve o md5 do que foi GRAVADO.
  const baixarPara = async (caso, relOrigem, relDestino) => {
    if (!isWorkdocPath(relOrigem) || !isSafeRelPath(relDestino)) {
      appendLog(casesBase, `workdocs ${caso}: path inseguro no plano (${relOrigem}) -> skip`);
      return null;
    }
    if (orcamentoDownload <= 0) return null;
    orcamentoDownload--;
    try {
      const url = `${apiBase}/cases/${encodeURIComponent(caso)}/workdocs/file?path=${encodeURIComponent(relOrigem)}`;
      const buf = await doGetBytes(url);
      const dest = join(casesBase, caso, ...relDestino.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeAtomic(dest, buf);
      return md5hex(buf);
    } catch (err) {
      erros++;
      appendLog(casesBase, `workdocs ${caso}: erro baixando ${relOrigem}: ${err.message}`);
      return null;
    }
  };

  for (const caso of casos) {
    const remoto = remoteCases[caso] || {};
    let local;
    try {
      local = readCaseWorkdocs(join(casesBase, caso));
    } catch (err) {
      erros++;
      appendLog(casesBase, `workdocs ${caso}: erro lendo pasta: ${err.message}`);
      continue;
    }
    // Preserva a distinção "sem md5" (presente e inelegível) da chave ausente:
    // é o que impede o planejador de emitir download por cima de trabalho local.
    // O `motivo` viaja junto para o aviso do plano sair específico no log.
    const localMd5 = {};
    for (const [p, info] of Object.entries(local)) {
      localMd5[p] = info.md5 !== undefined ? info.md5 : { motivo: info.motivo };
    }

    const plan = planWorkdocsSync({ manifest: remoto, localFiles: localMd5, baseline: baseline[caso] || {} });
    for (const w of plan.warnings) appendLog(casesBase, `workdocs ${caso}: ${w}`);

    const baixadosCaso = new Map(); // path -> md5 dos bytes gravados
    for (const rel of plan.downloads) {
      const md5Gravado = await baixarPara(caso, rel, rel);
      if (md5Gravado !== null) {
        baixadosCaso.set(rel, md5Gravado);
        baixados++;
      }
    }

    // Conflito: o local fica INTACTO; a versão remota materializa ao lado como
    // `<nome>.conflito-<slug><ext>`. Se já existe um arquivo de conflito com
    // OUTRO conteúdo (segundo conflito antes da reconciliação manual), sufixa em
    // vez de sobrescrever — nunca se perde texto. Sem slot livre, NADA é escrito
    // e o conflito NÃO entra no baseline: adotar o md5 remoto sem ter gravado
    // faria o local subir por cima e destruir a versão da VM.
    const conflitadosCaso = new Map(); // path -> md5 da cópia gravada
    for (const rel of plan.conflicts) {
      const remoteMd5 = typeof remoto[rel] === "string" ? remoto[rel] : remoto[rel]?.md5;
      const alvo = conflitPathDisponivel(join(casesBase, caso), rel, selfAuthor, remoteMd5);
      if (alvo === null) {
        appendLog(casesBase, `workdocs ${caso}: não foi possível nomear o conflito de ${rel} -> local preservado, nada escrito`);
        continue;
      }
      if (alvo.esgotado) {
        appendLog(
          casesBase,
          `workdocs ${caso}: ${CONFLICT_MAX_PROBES} slots de conflito de ${rel} ocupados -> nada escrito; ` +
            "reconcilie as cópias existentes para o canal voltar a andar",
        );
        continue;
      }
      if (alvo.jaMaterializado) {
        conflitadosCaso.set(rel, remoteMd5); // cópia idêntica já no disco: idempotente
        continue;
      }
      const md5Copia = await baixarPara(caso, rel, alvo.rel);
      if (md5Copia !== null) {
        conflitadosCaso.set(rel, md5Copia);
        conflitos++;
        appendLog(casesBase, `workdocs ${caso}: conflito em ${rel} -> local preservado, versão da VM em ${alvo.rel}`);
      }
    }

    for (const rel of plan.uploads) {
      const info = local[rel];
      if (!info) continue;
      uploadCandidatos.push({ case: caso, path: rel, size: info.size, md5: info.md5 });
    }

    registros.push({ caso, remoto, localMd5, baixadosCaso, conflitadosCaso });
  }

  if (orcamentoDownload <= 0) {
    appendLog(casesBase, `workdocs: teto de ${WORKDOC_MAX_TICK_DOWNLOADS} downloads por ciclo atingido -> resto no próximo tick`);
  }

  // ----- Uploads: batches sob os tetos do canal, agrupados por caso (a rota é
  // por caso; dividir um batch por caso só REDUZ o corpo, nunca estoura). -----
  const { batches, skipped, deferred } = planWorkdocUploadBatches(uploadCandidatos);
  for (const s of skipped) {
    appendLog(casesBase, `workdocs ${s.case}: upload pulado ${s.path}: ${s.reason}`);
  }
  if (deferred.length > 0) {
    appendLog(casesBase, `workdocs: ${deferred.length} arquivo(s) adiados para o próximo ciclo (teto por ciclo)`);
  }

  const enviadosPorCaso = new Map();
  let enviados = 0;
  for (const batch of batches) {
    const porCaso = new Map();
    for (const f of batch) {
      if (!porCaso.has(f.case)) porCaso.set(f.case, []);
      porCaso.get(f.case).push(f);
    }
    for (const [caso, arquivos] of porCaso) {
      const payload = [];
      for (const f of arquivos) {
        try {
          const buf = readFileSync(join(casesBase, caso, ...f.path.split("/")));
          // Mudou entre o scan e o envio: não sobe agora (o md5 do baseline
          // seria o do scan). O próximo ciclo pega a versão nova.
          if (md5hex(buf) !== f.md5) {
            appendLog(casesBase, `workdocs ${caso}: ${f.path} mudou durante o ciclo -> upload adiado`);
            continue;
          }
          payload.push({ path: f.path, content: buf.toString("base64") });
        } catch (err) {
          erros++;
          appendLog(casesBase, `workdocs ${caso}: erro lendo ${f.path} para upload: ${err.message}`);
        }
      }
      if (payload.length === 0) continue;
      let resp;
      try {
        resp = await doPost(`${apiBase}/cases/${encodeURIComponent(caso)}/workdocs`, { files: payload });
      } catch (err) {
        erros++;
        appendLog(casesBase, `workdocs ${caso}: erro upload: ${err.message}`);
        continue;
      }
      const recusados = new Map();
      if (Array.isArray(resp?.failed)) {
        for (const f of resp.failed) recusados.set(f?.path, f?.reason ?? "recusado");
      }
      if (!enviadosPorCaso.has(caso)) enviadosPorCaso.set(caso, new Set());
      for (const f of payload) {
        if (recusados.has(f.path)) {
          appendLog(casesBase, `workdocs ${caso}: upload recusado ${f.path}: ${recusados.get(f.path)}`);
          continue;
        }
        enviadosPorCaso.get(caso).add(f.path);
        enviados++;
      }
    }
  }

  // ----- Baseline: só o que teve êxito de fato entra. -----
  try {
    const next = {};
    for (const r of registros) {
      const entry = computeWorkdocsBaseline({
        manifest: r.remoto,
        localFiles: r.localMd5,
        baseline: baseline[r.caso] || {},
        downloaded: r.baixadosCaso,
        uploaded: enviadosPorCaso.get(r.caso) || new Set(),
        conflicted: r.conflitadosCaso,
      });
      if (Object.keys(entry).length > 0) next[r.caso] = entry;
    }
    writeWorkdocsBaseline(casesBase, next);
  } catch (err) {
    appendLog(casesBase, `workdocs: erro baseline: ${err.message}`);
  }

  if (baixados || enviados || conflitos || erros) {
    appendLog(
      casesBase,
      `workdocs: ${erros ? "erro" : "ok"} baixados=${baixados} uploads=${enviados} conflitos=${conflitos}` +
        (erros ? ` erros=${erros}` : ""),
    );
  }
}

/**
 * Resolve onde materializar a versão remota de um conflito dentro de `caseDir`.
 * Retorna `null` quando o nome não pode ser formado; senão
 * `{ rel, jaMaterializado, esgotado }`:
 *
 *  - slot livre                            -> `{rel, jaMaterializado:false}`;
 *  - slot ocupado com o MESMO conteúdo do
 *    remoto (`remoteMd5`)                  -> `{jaMaterializado:true}`, o
 *    ciclo anterior já preservou aquela versão (não rebaixa);
 *  - slot ocupado com conteúdo DIFERENTE   -> tenta `-2`, `-3`, ... (segundo
 *    conflito antes da reconciliação manual: sobrescrever apagaria texto que o
 *    usuário ainda não reconciliou);
 *  - todos os slots ocupados               -> `{esgotado:true}`: NADA foi
 *    escrito, então o caller NÃO pode tratar como materializado (adotar o md5
 *    remoto no baseline mandaria o local por cima e destruiria a versão da VM
 *    no ciclo seguinte). O conflito é reemitido no próximo tick.
 */
function conflitPathDisponivel(caseDir, rel, selfAuthor, remoteMd5) {
  const base = conflictPath(rel, selfAuthor);
  if (base === null) return null;
  const dot = base.lastIndexOf(".");
  const ext = base.slice(dot);
  const semExt = base.slice(0, dot);
  for (let n = 1; n <= CONFLICT_MAX_PROBES; n++) {
    const cand = n === 1 ? base : `${semExt}-${n}${ext}`;
    const abs = join(caseDir, ...cand.split("/"));
    if (!existsSync(abs)) return { rel: cand, jaMaterializado: false, esgotado: false };
    try {
      if (remoteMd5 !== undefined && md5hex(readFileSync(abs)) === remoteMd5) {
        return { rel: cand, jaMaterializado: true, esgotado: false };
      }
    } catch {
      // ilegível: trata como ocupado e tenta o próximo slot
    }
  }
  return { rel: null, jaMaterializado: false, esgotado: true };
}

// ---------- CMR-135: uploader de transcripts de sessao (Task 9) ----------
//
// O watcher do legal-cogmem so enxerga os JSONLs da VM. Nas maquinas cliente
// (cmr-002, Ana) os transcripts do Claude Code ficam em
// `<home>/.claude/projects/<projeto-encodado>/<sessao>.jsonl` e chegam ao
// daemon por HTTP (`POST /api/ingest-transcript`, Bearer obrigatorio).
//
// Invariantes:
//  - MINIMIZACAO: so sobem dirs cujo nome comeca pelo encode do `casesBase`
//    (`expectedTranscriptDirPrefix`) — comparacao por PREFIXO, nao substring.
//    Sessao fora da pasta de casos NUNCA sai da maquina; sem base, nada sobe.
//  - Recusa deterministica (400/403) bloqueia o DIRETORIO por 6h, com sonda
//    depois — 400/403 sao propriedades do dir (mesmo `cwd`), nao do arquivo.
//  - Estado PROPRIO em `.transcripts-state.json` (offset em bytes por arquivo);
//    `.sync-state.json` e `.memoria-state.json` sao INTOCAVEIS.
//  - So avanca o offset em 2xx. 500 (captura parcial), 401, 413 ou rede fora
//    mantem o offset e o proximo ciclo reenvia — o reenvio e idempotente pelo
//    dedupe do daemon (chunk_id_v2), entao overlap nao duplica.
//  - Grava o estado APOS CADA request: a tarefa do Windows tem
//    ExecutionTimeLimit de 5 min e um kill no meio nao pode perder progresso.

const TRANSCRIPT_STATE_FILE = ".transcripts-state.json";

// Teto do corpo no daemon e 4 MiB; 3 MiB de JSONL cru deixam folga para o
// escaping do envelope JSON ({"session_id","jsonl"}).
export const TRANSCRIPT_MAX_REQUEST_BYTES = 3 * 1024 * 1024;
// Teto por CICLO (soma de todas as janelas): o sync roda a cada 5 min e nao
// pode virar upload sustentado num backfill grande.
export const TRANSCRIPT_MAX_CYCLE_BYTES = 12 * 1024 * 1024;
// Recuo maximo ao alinhar o delta a fronteira de linha.
const TRANSCRIPT_ALIGN_LOOKBACK = 1024 * 1024;
// O embed de um delta grande e lento no daemon — timeout folgado (o do sync de
// briefing e 10s).
const TRANSCRIPT_TIMEOUT_MS = 30_000;

// Alfabeto do `session_id` aceito pelo daemon (`validate_session_id`). O veto a
// `..` espelha o servidor: um id que o server recusaria viraria 400 em loop.
const VALID_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Chave RESERVADA dentro do estado: `{ "<nome-do-dir>": { ts, status } }` —
// bloqueio por DIRETORIO de projeto. Nunca colide com uma chave real (as demais
// sao paths absolutos de arquivo).
const TRANSCRIPT_BLOCKED_KEY = "__blocked";

// Re-sonda um dir bloqueado a cada 6h: 400/403 sao verdades sobre o estado do
// SERVIDOR (posse) ou sobre o cwd do dir, e podem mudar (caso criado depois na
// VM). Um request de sonda por dir a cada 6h e barato.
const TRANSCRIPT_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Recusa DETERMINISTICA do daemon: 400 (o `cwd` do dir nao resolve para um slug
 * de caso valido) e 403 (o caso nao pertence ao tenant). As duas sao
 * propriedades do DIRETORIO de projeto, nao do arquivo — todos os `.jsonl`
 * daquele dir carregam o mesmo `cwd` e tomariam a mesma recusa.
 *
 * 401 (credencial), 413, 5xx e rede fora NAO entram: sao transitorios.
 */
function isRecusaDeterministica(status) {
  return status === 400 || status === 403;
}

/**
 * Raizes onde o Claude Code guarda transcripts. Mesmo layout nas duas
 * plataformas (`<home>/.claude/projects`); `platform` fica no contrato para o
 * dia em que divergirem. Pura.
 */
export function transcriptRoots(home, platform = process.platform) {
  void platform;
  return [join(home, ".claude", "projects")];
}

/**
 * Prefixo esperado dos dirs de projeto que ficam SOB a base de casos.
 *
 * O Claude Code encoda o path absoluto do projeto trocando TUDO que nao e
 * alfanumerico por `-` (separador, `:`, `_`, espaco, acento — verificado nos
 * dirs reais da cmr-002: `piggpay_sfdc` -> `piggpay-sfdc`, `societarios` com
 * acento -> `societ-rios`). Logo `C:\Users\pedro\cases` vira o prefixo
 * `C--Users-pedro-cases-` e `/home/opc/case-docs/cases` vira
 * `-home-opc-case-docs-cases-`. Pura.
 */
export function expectedTranscriptDirPrefix(casesBase) {
  const limpo = String(casesBase || "").replace(/[/\\]+$/, "");
  if (!limpo) return "";
  return `${limpo.replace(/[^a-zA-Z0-9]/g, "-")}-`;
}

/**
 * Dir de projeto do Claude Code cujo path esta SOB a base de casos.
 *
 * Compara por PREFIXO derivado da base (nao por substring `-cases-`): um repo
 * como `/home/opc/foo/cases-lib/...` ou uma pasta pessoal com `cases` no meio
 * do caminho nao sobe. Sem prefixo (base vazia) nada e elegivel — fail-closed.
 * NTFS e case-insensitive, entao no Windows a comparacao ignora caixa. Pura.
 */
export function isCaseTranscriptDir(name, prefix, platform = process.platform) {
  if (!name || !prefix) return false;
  if (platform === "win32") {
    return String(name).toLowerCase().startsWith(String(prefix).toLowerCase());
  }
  return String(name).startsWith(prefix);
}

/** `session_id` aceitavel pelo daemon. Pura. */
export function isValidSessionId(id) {
  return typeof id === "string" && VALID_SESSION_ID.test(id) && !id.includes("..");
}

/** Nome do dir de projeto a que um transcript pertence (chave do bloqueio). */
function transcriptDirName(path) {
  return basename(dirname(path));
}

/**
 * Enumera os `.jsonl` de sessoes de caso nas raizes dadas, em ordem estavel de
 * path (o orcamento do ciclo depende de ordem deterministica). So entram dirs
 * cujo nome comeca por `prefix` (ver `expectedTranscriptDirPrefix`). Raiz
 * ausente ou ilegivel e ignorada — o uploader nunca derruba o sync.
 * Retorna `[{ path, sessionId, size }]`.
 */
export function listTranscriptFiles(roots, prefix) {
  const out = [];
  for (const root of roots || []) {
    let dirs;
    try {
      dirs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // raiz inexistente (maquina sem CC nesse home) nao e erro
    }
    for (const d of dirs) {
      if (!d.isDirectory() || !isCaseTranscriptDir(d.name, prefix)) continue;
      const dirPath = join(root, d.name);
      let entries;
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const path = join(dirPath, e.name);
        let size;
        try {
          size = statSync(path).size;
        } catch {
          continue; // sumiu entre readdir e stat
        }
        out.push({ path, sessionId: e.name.slice(0, -".jsonl".length), size });
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Inicio da linha que contem `offset` (recuo maximo `lookback`).
 *
 * O offset salvo e o FIM da ultima janela enviada e cai no meio de uma linha
 * quando a janela foi cortada pelo cap. Comecar a proxima janela ali entregaria
 * um fragmento de JSON que o parser do daemon descarta — o turno se perderia.
 * Recuando para a fronteira de linha, o pedaco ja enviado volta junto e o
 * dedupe absorve o overlap.
 *
 * O recuo e LIMITADO por construcao: com `lookback <= maxRequestBytes/2` cada
 * ciclo avanca pelo menos metade da janela, entao nem uma linha maior que a
 * janela prende o arquivo em reenvio eterno. Sem `\n` na janela de lookback (ou
 * erro de I/O) nao recua — perder a linha da borda e melhor que travar.
 */
export function alignToLineStart(path, offset, lookback = TRANSCRIPT_ALIGN_LOOKBACK) {
  if (!offset || offset <= 0) return 0;
  const start = Math.max(0, offset - lookback);
  const len = offset - start;
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    const idx = buf.subarray(0, read).lastIndexOf(0x0a); // \n
    if (idx === -1) return start === 0 ? 0 : offset;
    return start + idx + 1;
  } catch {
    return offset;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd ja fechado */
      }
    }
  }
}

/**
 * Janelas a enviar neste ciclo: no maximo UMA por arquivo (arquivo maior que o
 * cap continua no proximo ciclo), respeitando o teto por request e o teto do
 * ciclo. `state` e `{ "<path-absoluto>": bytesEnviados }`.
 *
 * `size < offset` (arquivo truncado/rotacionado) reseta para 0 — o dedupe
 * impede duplicata do que ja foi capturado.
 *
 * DIRETORIO com recusa deterministica registrada (`__blocked`) fica inteiro de
 * fora ate o TTL expirar — sem rede, sem leitura de disco. Expirado o TTL,
 * exatamente UMA JANELA do dir entra como SONDA (se o servidor mudou de ideia,
 * o proximo ciclo destrava o dir todo). A sonda so e consumida quando ha janela
 * REAL: arquivo sem delta (ou sem span) nao a queima — senao um dir cujo
 * primeiro `.jsonl` esta em dia ficaria bloqueado para sempre, em silencio.
 *
 * Retorna `[{ path, sessionId, from, to }]`.
 */
export function planTranscriptUploads(files, state = {}, caps = {}, now = Date.now()) {
  const maxReq = caps.maxRequestBytes ?? TRANSCRIPT_MAX_REQUEST_BYTES;
  const maxCycle = caps.maxCycleBytes ?? TRANSCRIPT_MAX_CYCLE_BYTES;
  const lookback = Math.max(1, Math.min(TRANSCRIPT_ALIGN_LOOKBACK, Math.floor(maxReq / 2)));
  const blocked = readBlockedDirs(state);
  const sondados = new Set(); // dirs que ja gastaram a sonda deste ciclo
  const out = [];
  let budget = maxCycle;
  for (const f of files || []) {
    if (budget <= 0) break;
    const dir = transcriptDirName(f.path);
    const b = blocked[dir];
    if (b) {
      if (now - b.ts <= TRANSCRIPT_BLOCK_TTL_MS) continue; // dentro do TTL: nem tenta
      if (sondados.has(dir)) continue; // ja mandou a sonda deste dir neste ciclo
    }
    const size = Number(f.size) || 0;
    const saved = Number(state?.[f.path]);
    let from = Number.isFinite(saved) && saved > 0 ? saved : 0;
    if (from > size) from = 0; // truncado/rotacionado
    if (from >= size) continue; // nada novo
    if (from > 0) from = alignToLineStart(f.path, from, lookback);
    const span = Math.min(maxReq, budget, size - from);
    if (span <= 0) continue;
    if (b) sondados.add(dir); // sonda consumida so aqui: ha janela real para provar o dir
    out.push({ path: f.path, sessionId: f.sessionId, from, to: from + span });
    budget -= span;
  }
  return out;
}

/**
 * Bloqueios por diretorio, normalizados: `{ "<dir>": { ts, status } }`.
 *
 * Entradas do formato ANTIGO (v0.15.1, por ARQUIVO: `path -> size`) sao
 * DESCARTADAS na leitura — migrar nao vale o codigo: o pior caso e uma sonda
 * extra por dir, que re-bloqueia no formato novo.
 */
export function readBlockedDirs(state) {
  const raw = state?.[TRANSCRIPT_BLOCKED_KEY];
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [dir, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object" || typeof v.ts !== "number") continue;
    out[dir] = v;
  }
  return out;
}

function readTranscriptState(casesBase) {
  const p = join(casesBase, TRANSCRIPT_STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    const st = JSON.parse(readFileSync(p, "utf-8"));
    return st && typeof st === "object" ? st : {};
  } catch {
    return {}; // estado corrompido: reenvia (dedupe absorve), nao derruba o ciclo
  }
}

function writeTranscriptState(casesBase, state) {
  const path = join(casesBase, TRANSCRIPT_STATE_FILE);
  const tmp = `${path}.sync-tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, path);
}

/** Le `[from, to)` do arquivo. Retorna `{ text, bytes }` (bytes REALMENTE lidos). */
function readTranscriptSlice(path, from, to) {
  const len = Math.max(0, to - from);
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    const bytes = readSync(fd, buf, 0, len, from);
    // Corte em `to` pode partir um caractere multibyte: a linha da borda ja e
    // fragmento e o parser do daemon a descarta de qualquer forma.
    return { text: buf.subarray(0, bytes).toString("utf-8"), bytes };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd ja fechado */
      }
    }
  }
}

/**
 * `POST /api/ingest-transcript`. Nao lanca em resposta nao-ok: devolve
 * `{ ok, status, json, text }` para o chamador decidir. O 413 do axum vem em
 * TEXTO (nao JSON) — por isso o parse e tolerante.
 */
export async function postTranscript(url, body) {
  const res = await requestWithAuth((authHeaders) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
    }),
  );
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta nao-JSON (413 do axum) */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Sobe os deltas de transcript das sessoes de caso para o legal-cogmem.
 * NUNCA lanca: toda falha loga em `.sync.log` e o ciclo segue. `deps` injeta
 * rede/credencial/raizes nos testes.
 */
export async function syncTranscripts(memApiBase, casesBase, deps = {}) {
  const doPost = deps.postTranscript || postTranscript;
  const readCred = deps.readCredential || readCredential;
  const roots = deps.roots || transcriptRoots(homedir(), process.platform);

  // O ingest e ESCRITA: o daemon responde 401 sem claims mesmo com
  // REQUIRE_BEARER=false. Sem credencial nao ha o que tentar — 1 log e skip.
  let cred = null;
  try {
    cred = readCred();
  } catch {
    cred = null;
  }
  if (!cred || !cred.access_jwt) {
    appendLog(casesBase, "transcripts: sem credencial -> skip (rode o login do plugin)");
    return;
  }

  let state = readTranscriptState(casesBase);
  const prefix = deps.dirPrefix ?? expectedTranscriptDirPrefix(casesBase);
  let files = [];
  try {
    files = listTranscriptFiles(roots, prefix);
  } catch (err) {
    appendLog(casesBase, `transcripts: erro listando transcripts: ${err.message}`);
    return;
  }

  // Poda de offsets de arquivos que sumiram do disco (sessao apagada, projeto
  // removido): a chave so cresceria para sempre.
  const podadas = [];
  for (const k of Object.keys(state)) {
    if (k === TRANSCRIPT_BLOCKED_KEY) continue;
    if (!existsSync(k)) podadas.push(k);
  }
  if (podadas.length > 0) {
    const limpo = { ...state };
    for (const k of podadas) delete limpo[k];
    state = limpo;
    try {
      writeTranscriptState(casesBase, state);
    } catch (err) {
      appendLog(casesBase, `transcripts: erro gravando estado: ${err.message}`);
    }
  }

  const elegiveis = [];
  for (const f of files) {
    if (!isValidSessionId(f.sessionId)) {
      appendLog(casesBase, `transcripts: session_id invalido (${f.sessionId}) -> skip`);
      continue;
    }
    elegiveis.push(f);
  }

  let plan = [];
  try {
    plan = planTranscriptUploads(elegiveis, state, deps.caps);
  } catch (err) {
    appendLog(casesBase, `transcripts: erro planejando: ${err.message}`);
    return;
  }
  if (plan.length === 0) return; // nada novo: ciclo silencioso

  const url = `${memApiBase}/ingest-transcript`;
  let janelas = 0;
  let capturados = 0;
  let falhas = 0;
  // Dirs recusados DENTRO deste ciclo: o plano ja estava fechado quando a
  // recusa chegou, entao os irmaos do mesmo dir precisam sair aqui (sem esse
  // corte, um dir com N sessoes gastaria N requests antes de bloquear).
  const recusadosNoCiclo = new Set();

  for (const w of plan) {
    if (recusadosNoCiclo.has(transcriptDirName(w.path))) continue;
    let slice;
    try {
      slice = readTranscriptSlice(w.path, w.from, w.to);
    } catch (err) {
      appendLog(casesBase, `transcripts: erro lendo ${w.sessionId}: ${err.message}`);
      falhas++;
      continue;
    }
    // Janela so com espaco em branco: o daemon devolveria 400 "jsonl vazio" e o
    // arquivo travaria. Nao ha turno a perder — avanca o offset e segue.
    if (!slice.text.trim()) {
      state = { ...state, [w.path]: w.from + slice.bytes };
      try {
        writeTranscriptState(casesBase, state);
      } catch (err) {
        appendLog(casesBase, `transcripts: erro gravando estado: ${err.message}`);
      }
      continue;
    }

    let res;
    try {
      res = await doPost(url, { session_id: w.sessionId, jsonl: slice.text });
    } catch (err) {
      appendLog(casesBase, `transcripts: erro no POST ${w.sessionId}: ${err.message}`);
      falhas++;
      continue;
    }
    if (!res || !res.ok) {
      const detalhe = String(res?.json?.error ?? res?.json?.message ?? res?.text ?? "sem resposta").slice(0, 200);
      appendLog(casesBase, `transcripts: HTTP ${res?.status ?? "?"} em ${w.sessionId}: ${detalhe}`);
      falhas++;
      // Recusa deterministica: bloqueia o DIRETORIO (todos os .jsonl dele tem o
      // mesmo `cwd` e tomariam a mesma recusa) com carimbo de tempo. O offset
      // NAO avanca — nada foi dado como capturado. O TTL de 6h manda a proxima
      // sonda; se o caso passar a existir/pertencer, ela destrava o dir.
      if (res && isRecusaDeterministica(res.status)) {
        const dir = transcriptDirName(w.path);
        recusadosNoCiclo.add(dir);
        state = {
          ...state,
          [TRANSCRIPT_BLOCKED_KEY]: {
            ...readBlockedDirs(state),
            [dir]: { ts: Date.now(), status: res.status },
          },
        };
        try {
          writeTranscriptState(casesBase, state);
        } catch (err) {
          appendLog(casesBase, `transcripts: erro gravando estado: ${err.message}`);
        }
        appendLog(casesBase, `transcripts: dir ${dir} bloqueado por 6h (recusa ${res.status})`);
      }
      continue; // NAO avanca o offset: o proximo ciclo reenvia (dedupe absorve)
    }

    // 2xx (inclusive `skipped:true`, sessao fora de caso): o delta esta
    // resolvido do lado do servidor -> avanca e PERSISTE imediatamente.
    state = { ...state, [w.path]: w.from + slice.bytes };
    const dirOk = transcriptDirName(w.path);
    if (readBlockedDirs(state)[dirOk]) {
      const restante = readBlockedDirs(state);
      delete restante[dirOk]; // o dir voltou a ser aceito: some o bloqueio
      state = { ...state, [TRANSCRIPT_BLOCKED_KEY]: restante };
      appendLog(casesBase, `transcripts: dir ${dirOk} desbloqueado (sonda aceita)`);
    }
    try {
      writeTranscriptState(casesBase, state);
    } catch (err) {
      appendLog(casesBase, `transcripts: erro gravando estado: ${err.message}`);
    }
    janelas++;
    capturados += Number(res.json?.captured) || 0;
  }

  // "ok" so quando o ciclo produziu alguma coisa: falhas sem captura nenhuma
  // nao podem sair como sucesso no log.
  const rotulo = falhas > 0 && capturados === 0 ? "erros" : "ok";
  const bloqueados = Object.keys(readBlockedDirs(state)).length;
  appendLog(
    casesBase,
    `transcripts: ${rotulo} janelas=${janelas} capturados=${capturados}` +
      (falhas ? ` falhas=${falhas}` : "") +
      (bloqueados ? ` bloqueados=${bloqueados}` : ""),
  );
}

/**
 * Espelho do scaffolding (styles/rules/templates/scripts/CLAUDE.md do root)
 * — CMR-156. Politica DIFERENTE dos briefings de caso: a VM e a FONTE
 * AUTOMATICA (regra documentada: "alterar output style ou rules: VM, depois
 * synca"). O espelho SEMPRE aplica a versao da VM; possivel edicao local
 * (local != baseline registrado, ou sem baseline — maquinas provisionadas
 * antes desta feature) e preservada ao lado em `<arquivo>.bak` + log, nunca
 * bloqueia o update (senao o bootstrap das maquinas antigas travaria pra
 * sempre). Pura: caller le/escreve o disco.
 */
export function planScaffoldingSync(files, localState, baseline) {
  const plan = { write: [], backup: [], baseline: {} };
  for (const f of files || []) {
    if (
      !f ||
      !isSafeScaffoldingPath(f.path) ||
      typeof f.content !== "string" ||
      typeof f.md5 !== "string"
    ) {
      continue;
    }
    const local = localState[f.path] ?? null;
    plan.baseline[f.path] = f.md5;
    if (local === f.md5) continue; // em dia
    plan.write.push(f);
    const base = baseline[f.path] ?? null;
    if (local !== null && local !== base) plan.backup.push(f.path);
  }
  return plan;
}

function scaffoldingStatePath(casesBase) {
  return join(casesBase, ".scaffolding-state.json");
}

function readScaffoldingState(casesBase) {
  try {
    const obj = JSON.parse(readFileSync(scaffoldingStatePath(casesBase), "utf-8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/** Executa o espelho do scaffolding. Nunca lanca; erro vira linha de log. */
export async function syncScaffolding(apiBase, casesBase) {
  let manifest;
  try {
    manifest = await fetchJson(`${apiBase}/scaffolding`);
  } catch (err) {
    appendLog(casesBase, `scaffolding: erro manifest: ${err.message}`);
    return;
  }
  const files = manifest.files || [];
  if (files.length === 0) return; // manifest vazio = erro no servidor; nao mexe

  const baseline = readScaffoldingState(casesBase).files || {};
  const localState = {};
  for (const f of files) {
    if (!f || !isSafeScaffoldingPath(f.path)) continue;
    try {
      localState[f.path] = md5hex(readFileSync(join(casesBase, ...f.path.split("/"))));
    } catch {
      localState[f.path] = null;
    }
  }

  const plan = planScaffoldingSync(files, localState, baseline);
  let updated = 0;
  let backups = 0;
  for (const f of plan.write) {
    const dest = join(casesBase, ...f.path.split("/"));
    try {
      if (plan.backup.includes(f.path)) {
        copyFileSync(dest, `${dest}.bak`);
        backups++;
        appendLog(casesBase, `scaffolding: versao local de ${f.path} preservada em ${f.path}.bak`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeAtomic(dest, f.content);
      updated++;
    } catch (err) {
      appendLog(casesBase, `scaffolding: erro em ${f.path}: ${err.message}`);
    }
  }
  try {
    writeAtomic(
      scaffoldingStatePath(casesBase),
      `${JSON.stringify({ files: plan.baseline }, null, 2)}\n`,
    );
  } catch (err) {
    appendLog(casesBase, `scaffolding: erro baseline: ${err.message}`);
  }
  if (updated || backups) {
    appendLog(casesBase, `scaffolding: atualizados=${updated}${backups ? ` backups=${backups}` : ""}`);
  }
}

/**
 * Self-update do clone do marketplace de onde esta task roda. O autoUpdate
 * do CC (known_marketplaces.json) nao faz fetch do marketplace no startup
 * (constatado empiricamente em 03/08: FETCH_HEAD parado por 3+ dias com a
 * flag ligada e multiplos startups) — sem isto, cada release exigiria acao
 * manual em cada maquina cliente. `--ff-only` nunca cria merge: clone dirty
 * ou divergente falha limpo e vira linha de log. O processo corrente ja
 * carregou os modulos antigos; o codigo novo vale a partir do proximo ciclo.
 * Retorna sempre uma linha de log; nunca lanca.
 */
export function selfUpdateMarketplace(scriptDir, deps = {}) {
  const exists = deps.exists || existsSync;
  const spawn = deps.spawn || spawnSync;
  // scriptDir = <cloneRoot>/plugins/case-knowledge
  const cloneRoot = dirname(dirname(scriptDir));
  if (!exists(join(cloneRoot, ".git"))) {
    return "self-update: pulado (sem .git — cache install ou copia avulsa)";
  }
  const run = (args) =>
    spawn("git", ["-C", cloneRoot, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  const before = run(["rev-parse", "--short", "HEAD"]);
  const pull = run(["pull", "--ff-only"]);
  if (pull.error) return `self-update: falhou (${pull.error.message})`;
  if (pull.status !== 0) {
    const motivo =
      String(pull.stderr || pull.stdout || "").trim().split("\n")[0] || `exit ${pull.status}`;
    return `self-update: falhou (${motivo})`;
  }
  const oldHead = String(before.stdout || "").trim();
  const newHead = String(run(["rev-parse", "--short", "HEAD"]).stdout || "").trim();
  if (oldHead && newHead && oldHead !== newHead) {
    return `self-update: clone atualizado ${oldHead} -> ${newHead} (vale a partir do proximo ciclo)`;
  }
  return "self-update: clone ja atualizado";
}

async function main() {
  const apiBase = process.env.CASE_KNOWLEDGE_API_BASE || defaultApiBase();
  const casesBase = process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase();
  mkdirSync(casesBase, { recursive: true });

  // Self-update ANTES de tudo: mesmo um ciclo que falhe adiante ja deixou o
  // canal de release em dia. "ja atualizado" nao e logado (1 linha a cada
  // 5 min so de ruido); atualizacao, pulo e falha sao — falha silenciosa no
  // canal de release e exatamente o defeito do autoUpdate do CC.
  try {
    const line = selfUpdateMarketplace(dirname(fileURLToPath(import.meta.url)));
    if (!line.includes("ja atualizado")) appendLog(casesBase, line);
  } catch (err) {
    appendLog(casesBase, `self-update: erro inesperado: ${err.message}`);
  }

  // CMR-138: autor da memoria (namespace-por-autor) derivado UMA vez do access_jwt,
  // no INICIO (a injecao de autoMemoryDirectory por-caso da Task 11 precisa do
  // selfAuthor no path). E o claim `author_dir` (slug legivel, ex. `pedro-giudice`),
  // com fallback pro `sub` em token antigo. Sem credencial -> null: a memoria e
  // pulada e o sync de briefing segue normal. Try/catch defensivo: uma falha
  // rara ao ler a credencial NUNCA pode derrubar o sync de briefing abaixo.
  let selfAuthor = null;
  try {
    const cred = readCredential();
    selfAuthor = cred && cred.access_jwt ? decodeJwtAuthorDir(cred.access_jwt) : null;
  } catch {
    selfAuthor = null;
  }

  let manifest;
  try {
    manifest = await fetchJson(`${apiBase}/cases/sync-manifest`);
  } catch (err) {
    appendLog(casesBase, `erro manifest: ${err.message}`);
    return; // proximo ciclo e o retry
  }

  const manifestCases = manifest.cases || [];
  const localState = readLocalState(casesBase);
  const baseline = readBaselineFrom(casesBase);
  const plan = planActions(manifestCases, localState, baseline);
  let updated = 0;
  const errors = [];
  const succeeded = new Set();

  for (const name of plan.mkdir) {
    mkdirSync(join(casesBase, name), { recursive: true });
  }

  for (const { name, files } of plan.download) {
    try {
      const briefing = await fetchJson(`${apiBase}/cases/${encodeURIComponent(name)}/briefing`);
      for (const f of files) {
        const remote = briefing.files?.[f];
        if (!remote) continue; // sumiu entre manifest e fetch; proximo ciclo resolve
        writeAtomic(join(casesBase, name, f), remote.content);
        // Chave deve usar nome do dir local (plan.download[].name = targetName),
        // igual ao que computeBaseline usa em `${localName} ${file}`. NTFS-safe.
        succeeded.add(`${name} ${f}`);
        updated++;
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  // Provisiona .claude/settings.local.json dos casos do manifest: cria-se-ausente
  // (outputStyle/permissions do scaffolding + override `output_style:` do case.yaml)
  // e injeta autoMemoryDirectory (CMR-138) tambem em legados; nunca sobrescreve
  // config existente (CMR-103). Roda DEPOIS dos downloads: caso novo precisa do
  // case.yaml ja no disco para o override valer no nascimento. Dirs locais fora
  // do manifest nao sao tocados.
  let provisioned = 0;
  try {
    provisioned = provisionCaseSettings(casesBase, manifestCases, localState, selfAuthor, errors);
  } catch (err) {
    errors.push(`settings: ${err.message}`);
  }

  let archived = 0;
  if (plan.orphans.length > 0) {
    const archiveDir = join(casesBase, "_archive");
    mkdirSync(archiveDir, { recursive: true });
    const taken = new Set(readdirSync(archiveDir));
    for (const name of plan.orphans) {
      try {
        const target = archiveTarget(name, taken);
        renameSync(join(casesBase, name), join(archiveDir, target));
        taken.add(target);
        archived++;
      } catch (err) {
        errors.push(`orfao ${name}: ${err.message}`);
      }
    }
  }

  // Persiste o baseline (md5 da versao da VM por arquivo sincronizado).
  try {
    writeBaseline(casesBase, computeBaseline(manifestCases, localState, baseline, succeeded));
  } catch (err) {
    errors.push(`baseline: ${err.message}`);
  }

  // Loga edicoes locais preservadas (visibilidade para reconciliar a mao).
  for (const { name, file } of plan.conflicts) {
    appendLog(casesBase, `conflito preservado: ${name}/${file} editado localmente diverge da VM (nao sobrescrito)`);
  }

  const summary =
    `${errors.length ? "erro" : "ok"} mkdir=${plan.mkdir.length} ` +
    `arquivos_atualizados=${updated} orfaos_arquivados=${archived} conflitos=${plan.conflicts.length}` +
    (provisioned ? ` settings_provisionados=${provisioned}` : "") +
    (errors.length ? ` ERROS: ${errors.join(" | ")}` : "");
  appendLog(casesBase, summary);

  // CMR-156: espelha o scaffolding (styles/rules/templates) da VM. Estado
  // proprio (.scaffolding-state.json); nunca lanca; sessoes do CC abertas so
  // veem o style novo ao reabrir.
  try {
    await syncScaffolding(apiBase, casesBase);
  } catch (err) {
    appendLog(casesBase, `scaffolding: erro inesperado: ${err.message}`);
  }

  // CMR-138: sincroniza a memoria de caso por-autor (peers + upload do self).
  // Roda DEPOIS do briefing/settings, com estado e log PROPRIOS
  // (.memoria-state.json). syncMemoria nunca lanca; o try/catch e ultima linha
  // de defesa para garantir que a memoria jamais derrube o sync de briefing.
  try {
    await syncMemoria(apiBase, casesBase, selfAuthor);
  } catch (err) {
    appendLog(casesBase, `memoria: erro inesperado: ${err.message}`);
  }

  // CMR-135: sobe os transcripts de sessao de caso desta maquina para o
  // legal-cogmem (o watcher do daemon so ve os JSONLs da VM). Estado e log
  // PROPRIOS (.transcripts-state.json); nunca toca os estados vizinhos.
  // syncTranscripts nunca lanca; o try/catch e ultima linha de defesa.
  try {
    const memApiBase = process.env.LEGAL_COGMEM_API_BASE || defaultMemApiBase();
    await syncTranscripts(memApiBase, casesBase);
  } catch (err) {
    appendLog(casesBase, `transcripts: erro inesperado: ${err.message}`);
  }

  // CMR-161: espelha os workdocs (.md/.py) da pasta do caso — pool comum do
  // escritório. Roda POR ÚLTIMO de propósito: é a fase nova e não pode roubar
  // o orçamento de tempo do ciclo (a tarefa do Windows tem ExecutionTimeLimit
  // de 5 min) das fases já estabelecidas. Estado e log PRÓPRIOS
  // (.workdocs-state.json); syncWorkdocs nunca lança, o try/catch é última
  // linha de defesa.
  try {
    await syncWorkdocs(apiBase, casesBase, selfAuthor);
  } catch (err) {
    appendLog(casesBase, `workdocs: erro inesperado: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // ultima linha de defesa: nunca propagar exit != 0 pro scheduler
    try { appendLog(process.env.CASE_KNOWLEDGE_CASES_BASE || defaultCasesBase(), `erro fatal: ${err.message}`); } catch {}
  });
}
