#!/usr/bin/env node
/**
 * Extração automática de texto dos workdocs — WIRING (disco + orçamento).
 *
 * Chamado pelo tick do sync (fase extrairTextos, antes do syncWorkdocs) e pelo
 * hook SessionStart (hooks/extracao-sessao.mjs). Toda decisão pura está em
 * extracao.mjs; aqui só varredura, md5, leitura dos bytes, escrita atômica,
 * orçamento de tempo e o cache negativo.
 *
 * Cada original é extraído num PROCESSO FILHO (`--arquivo`), com teto de
 * memória e de tempo: uma planilha de 40 MiB leva o exceljs a 4 GB e o V8 mata
 * o processo sem catch possível, e um .docx malicioso pode inflar centenas de
 * MiB. No processo do tick ou do hook isso derrubaria a rodada inteira a cada
 * 5 min (ou estouraria o timeout do hook); no filho, vira um item em `erros`.
 * O filho é este mesmo arquivo, da mesma instalação de quem chamou (o cache
 * install no hook, o clone do marketplace no tick), e os leitores de formato só
 * são importados por ele: o processo pai nunca carrega exceljs e cia.
 *
 * Cache negativo (`<casesBase>/.extracao-falhas.json`, dotfile: fora do pool):
 * o arquivo que falhou (tempo, memória, leitor que não abre) não é tentado de
 * novo enquanto for o mesmo (md5) e o plugin for o mesmo; sem isso, o mesmo
 * arquivo custaria 90 s de cada tick para sempre. O cache também faz o log de
 * "grande demais" e de "sidecar do usuário" sair uma vez só.
 *
 * Nenhuma exceção escapa de extrairCaso/extrairTodos: falha de um arquivo vai
 * para `erros` e a varredura segue; nada é omitido calado (o que não foi
 * extraído aparece em `adiados`, `grandes`, `naoTocados` ou `erros`).
 *
 * Determinismo: nada que dependa de hora ou de máquina chega ao sidecar, e todo
 * caminho relativo usa `/` (também no Windows), para que a segunda rodada sobre
 * o mesmo original produza o mesmo arquivo byte a byte e o pool não o recircule.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, lstatSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isExcludedDirName, WORKDOC_MAX_DEPTH } from "./workdocs.mjs";
import { planejarExtracao, nomeSidecar, tipoDeFormato, ehOriginalElegivel, montarSidecar, renderDocx, renderXlsx, renderEmail, tamanhoLegivel } from "./extracao.mjs";

export const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
export const MAX_ANEXO_BYTES = 20 * 1024 * 1024;
export const MAX_SAIDA_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_NIVEL_ANEXO = 1;
// Teto por arquivo do pool de workdocs (WORKDOC_MAX_FILE_BYTES em workdocs.mjs):
// sidecar acima disso fica só nesta máquina, e quem lê precisa saber.
export const POOL_MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
// Teto de tempo por arquivo no tick; o hook passa 45 s (o timeout dele é 90 s).
export const LIMITE_POR_ARQUIVO_MS = 90_000;
// Heap do filho: contém o estrago de um leitor guloso sem tirar a máquina do
// advogado do ar (o default do V8 acompanha a RAM da máquina).
const MAX_HEAP_FILHO_MB = 1024;
export const ARQUIVO_FALHAS = ".extracao-falhas.json";
const CAMINHO_EXTRAIR = fileURLToPath(import.meta.url);
const SUFIXO_ANEXOS = ".anexos";
const RESERVADOS_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Nome de anexo pode ser o assunto inteiro do e-mail (.msg aninhado): sem teto,
// um nome acima do limite do sistema de arquivos derrubaria a extração do
// e-mail todo (ENAMETOOLONG).
const MAX_NOME_ANEXO = 150;

// md5hex e escreverAtomico são cópias locais DE PROPÓSITO: importar de
// sync-cases.mjs carregaria auth.mjs/@napi-rs/keyring em todo hook
// SessionStart, que só precisa extrair.
function md5hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

// Mesmo contrato do writeAtomic de sync-cases.mjs: tmp + rename; se o rename
// falha (destino aberto no Windows), o tmp é removido antes de relançar. O
// sufixo leva o pid: hook e tick podem gravar o mesmo sidecar ao mesmo tempo, e
// com um tmp comum um apagaria ou renomearia o arquivo pela metade do outro.
function sufixoTmp(pid = process.pid) {
  return `.extracao-tmp-${pid}`;
}

function escreverAtomico(path, conteudo) {
  const tmp = `${path}${sufixoTmp()}`;
  if (Buffer.isBuffer(conteudo)) writeFileSync(tmp, conteudo);
  else writeFileSync(tmp, conteudo, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // limpeza é best-effort; o erro que importa é o do rename
    }
    throw err;
  }
}

/**
 * Nome de anexo (vindo do remetente, não confiável) -> nome de arquivo gravável
 * no NTFS e no ext4. Segmentos `.`/`..` somem (o anexo nunca sai da pasta
 * `.anexos/`); separadores viram `_`; `<>:"|?*` também (no NTFS `RE: x` criaria
 * um fluxo alternativo, não um arquivo); ponto inicial sai (dotfile é invisível
 * para a varredura e para o canal); ponto e espaço finais saem (o Windows os
 * descarta e o nome divergiria do que gravamos).
 */
export function sanitizarNomeAnexo(nome) {
  const semControle = String(nome ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  let s = semControle
    .split(/[\\/]/)
    .filter((seg) => seg.trim() !== "" && seg.trim() !== "." && seg.trim() !== "..")
    .join("_");
  s = s.replace(/[<>:"|?*]/g, "_").trim().replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!s) return "anexo-sem-nome";
  if (RESERVADOS_WIN.test(s)) s = `_${s}`;
  if (s.length > MAX_NOME_ANEXO) {
    const ponto = s.lastIndexOf(".");
    const ext = ponto > 0 && s.length - ponto <= 10 ? s.slice(ponto) : "";
    s = s.slice(0, MAX_NOME_ANEXO - ext.length).replace(/[. ]+$/, "") + ext;
  }
  return s;
}

/**
 * Varre o caso: originais elegíveis {rel: {md5, bytes}}, os textos dos
 * sidecars que existem ao lado deles e os originais acima do teto de 50 MiB
 * (`grandes`, só com tamanho e mtime: não são lidos). Só o .md que é sidecar
 * de um original é lido (o caso pode ter centenas de notas .md que não
 * interessam aqui). Os bytes dos originais NÃO ficam em memória: só o md5.
 * Não segue symlink: o dirent descreve a própria entrada.
 */
function varrer(caseDir, { maxOriginalBytes }) {
  const originais = {};
  // .md por nome SEM caixa: no NTFS `A.DOCX.MD` do usuário é o mesmo arquivo
  // que o `A.DOCX.md` que escreveríamos; precisa ser visto para não ser pisado
  const mds = new Map();
  const grandes = [];
  const erros = [];
  const walk = (dir, prefixo, prof) => {
    if (prof > WORKDOC_MAX_DEPTH) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (e.name.startsWith(".")) continue;
      const rel = prefixo ? `${prefixo}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!isExcludedDirName(e.name)) walk(abs, rel, prof + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (rel.toLowerCase().endsWith(".md")) {
        mds.set(rel.toLowerCase(), rel);
        continue;
      }
      // Anexo além do nível permitido não é original: o sidecar do e-mail que o
      // gravou já traz o aviso, e reportá-lo aqui repetiria o item a cada rodada.
      if (!ehOriginalElegivel(rel) || nivelDeAnexo(rel) > MAX_NIVEL_ANEXO) continue;
      try {
        const st = statSync(abs);
        if (st.size > maxOriginalBytes) {
          grandes.push({ rel, bytes: st.size, mtimeMs: st.mtimeMs });
          continue;
        }
        const b = readFileSync(abs);
        originais[rel] = { md5: md5hex(b), bytes: b.length };
      } catch (err) {
        erros.push({ rel, erro: `ilegível (${err.code || err.message})` });
      }
    }
  };
  walk(caseDir, "", 0);
  const sidecars = {};
  for (const rel of Object.keys(originais)) {
    const sc = nomeSidecar(rel);
    const existente = mds.get(sc.toLowerCase());
    if (existente === undefined) continue;
    try {
      sidecars[sc] = readFileSync(join(caseDir, existente), "utf-8");
    } catch (err) {
      // sem ler o sidecar não dá para saber se é do usuário: não extrai
      delete originais[rel];
      erros.push({ rel, erro: `sidecar ilegível (${err.code || err.message})` });
    }
  }
  return { originais, sidecars, grandes, erros };
}

// Cada diretório terminado em `.anexos` no caminho é um nível de anexo.
function nivelDeAnexo(rel) {
  return rel.split("/").slice(0, -1).filter((d) => d.endsWith(SUFIXO_ANEXOS)).length;
}

// Recusa componente já existente como symlink (mesma defesa do
// resolveWorkdocDestino): escrever através dele sairia da pasta do caso.
function destinoSeguro(caseDir, rel) {
  let p = caseDir;
  for (const seg of rel.split("/")) {
    p = join(p, seg);
    try {
      if (lstatSync(p).isSymbolicLink()) return null;
    } catch {
      // ainda não existe
    }
  }
  return p;
}

function plural(n, um, varios) {
  return `${n} ${n === 1 ? um : varios}`;
}

// Teto de saída do .xlsx: tira abas inteiras do fim e, se a última que sobrou
// ainda não couber, as linhas do fim dela (busca binária: re-renderizar linha a
// linha seria quadrático em planilha de milhares de linhas).
function renderXlsxNoTeto(d, maxSaidaBytes, avisos) {
  let corpo = renderXlsx(d);
  const visiveis = () => d.abas.map((a, i) => (a.oculta ? -1 : i)).filter((i) => i >= 0);
  while (Buffer.byteLength(corpo) > maxSaidaBytes && visiveis().length > 1) {
    const idx = visiveis().pop();
    avisos.push(`saída acima do teto de 1,5 MiB: aba ${d.abas[idx].nome} ficou de fora`);
    d.abas.splice(idx, 1);
    corpo = renderXlsx(d);
  }
  if (Buffer.byteLength(corpo) > maxSaidaBytes) {
    const aba = d.abas[visiveis()[0]];
    if (aba) {
      const todas = aba.linhas;
      let lo = 1;
      let hi = todas.length;
      while (lo < hi) {
        const meio = Math.ceil((lo + hi) / 2);
        aba.linhas = todas.slice(0, meio);
        if (Buffer.byteLength(renderXlsx(d)) <= maxSaidaBytes) lo = meio;
        else hi = meio - 1;
      }
      aba.linhas = todas.slice(0, lo);
    }
    avisos.push("saída acima do teto de 1,5 MiB: linhas do fim da última aba ficaram de fora");
    corpo = renderXlsx(d);
  }
  return corpo;
}

// Falha de E/S (disco cheio, destino aberto no Windows) é do momento, não do
// arquivo: não entra no cache negativo, a próxima rodada tenta de novo.
function transitorio(err) {
  err.transitorio = true;
  return err;
}

/**
 * Extrai UM original: lê com o leitor do formato (importado aqui, só no
 * processo que extrai), grava o sidecar e, se for e-mail, os anexos.
 * Devolve {detalhe, avisos, novosOriginais} ou {adiar: motivo}; lança quando o
 * arquivo não pode ser extraído (o chamador decide se é falha do arquivo).
 */
async function extrairUm(caseDir, rel, buf, limites) {
  const tipo = tipoDeFormato(rel);
  const fonte = rel.slice(rel.lastIndexOf("/") + 1);
  let corpo;
  let avisos;
  let detalhe;
  const novosOriginais = [];
  if (tipo === "docx") {
    const { lerDocx } = await import("./extracao/docx.mjs");
    const d = lerDocx(buf);
    corpo = renderDocx(d);
    avisos = d.avisos;
    // parágrafos e tabelas trazem `segmentos`; revisor = autor de marca de revisão
    const revisores = new Set(d.blocos.flatMap((b) => (b.segmentos ?? []).filter((s) => s.marca).map((s) => s.autor)));
    detalhe = `${plural(revisores.size, "revisor", "revisores")}, ${plural(d.comentarios.length, "comentário", "comentários")}`;
  } else if (tipo === "xlsx") {
    const { lerXlsx } = await import("./extracao/xlsx.mjs");
    const d = await lerXlsx(buf, { maxBytes: limites.maxBytesPorArquivo });
    if (d.grandeDemais) return { adiar: `grande demais para extrair agora (${tamanhoLegivel(buf.length)})` };
    avisos = d.avisos;
    corpo = renderXlsxNoTeto(d, limites.maxSaidaBytes, avisos);
    detalhe = plural(d.abas.filter((a) => !a.oculta).length, "aba", "abas");
  } else {
    const { lerEml, lerMsg } = await import("./extracao/email.mjs");
    const e = tipo === "eml" ? await lerEml(buf) : lerMsg(buf);
    avisos = e.avisos;
    const dirAnexos = `${rel}${SUFIXO_ANEXOS}`;
    const nivelDosAnexos = nivelDeAnexo(rel) + 1;
    const usados = new Set();
    // conta o que de fato vai ter (ou já tem) sidecar, não o que foi só gravado
    let extraiveis = 0;
    for (const a of e.anexos) {
      // nome cru veio do remetente: o sidecar nunca mostra `../x`
      const nomeCru = a.nome;
      a.nome = sanitizarNomeAnexo(nomeCru);
      if (a.conteudo == null) {
        // o leitor, quando lançou ao ler o anexo, já registrou o aviso
        if (!avisos.some((x) => x.startsWith(`anexo ${nomeCru} `))) avisos.push(`anexo ${a.nome} sem conteúdo legível`);
        continue;
      }
      if (a.bytes > limites.maxAnexoBytes) {
        avisos.push(`anexo ${a.nome} acima do teto de 20 MiB (${tamanhoLegivel(a.bytes)}); não extraído`);
        continue;
      }
      // dois anexos com o mesmo nome (sem caixa: NTFS) não se sobrescrevem
      let nome = a.nome;
      for (let i = 2; usados.has(nome.toLowerCase()); i++) nome = a.nome.replace(/(\.[^.]*)?$/, `-${i}$1`);
      usados.add(nome.toLowerCase());
      const relAnexo = `${dirAnexos}/${nome}`;
      const destino = destinoSeguro(caseDir, relAnexo);
      if (!destino) {
        avisos.push(`anexo ${a.nome} não gravado: caminho passa por symlink`);
        continue;
      }
      // falha ao gravar UM anexo (pasta .anexos que é arquivo, disco cheio,
      // destino aberto no Windows) não pode custar o sidecar do e-mail
      try {
        mkdirSync(join(caseDir, dirAnexos), { recursive: true });
        // só grava se mudou: reescrever bytes iguais mudaria o mtime e acordaria o pool à toa
        if (!existsSync(destino) || !readFileSync(destino).equals(a.conteudo)) escreverAtomico(destino, a.conteudo);
      } catch (err) {
        avisos.push(`anexo ${a.nome} não gravado (${err.code || err.message})`);
        continue;
      }
      a.caminho = relAnexo;
      if (!ehOriginalElegivel(relAnexo)) continue;
      if (nivelDosAnexos > MAX_NIVEL_ANEXO) {
        avisos.push(`anexo ${a.nome} de e-mail aninhado não extraído (só um nível)`);
        continue;
      }
      extraiveis += 1;
      novosOriginais.push(relAnexo);
    }
    corpo = renderEmail(e);
    detalhe = `${plural(e.anexos.length, "anexo", "anexos")}, ${plural(extraiveis, "extraído", "extraídos")}`;
  }
  let md = montarSidecar({ fonte, md5: md5hex(buf), bytes: buf.length, avisos, corpo });
  if (Buffer.byteLength(md) > limites.poolMaxSidecarBytes) {
    // o aviso tem que estar NO sidecar: monta de novo com ele (determinístico,
    // o resultado só depende do original)
    avisos.push("sidecar acima de 2 MiB: não circula pelo pool de workdocs");
    md = montarSidecar({ fonte, md5: md5hex(buf), bytes: buf.length, avisos, corpo });
  }
  const destino = destinoSeguro(caseDir, nomeSidecar(rel));
  if (!destino) throw new Error("caminho do sidecar passa por symlink");
  try {
    escreverAtomico(destino, md);
  } catch (err) {
    throw transitorio(err);
  }
  return { detalhe, avisos, novosOriginais };
}

/**
 * extrairUm sem exceção: o mesmo contrato do resultado do processo filho
 * ({ok, sidecar, detalhe, avisos, novosOriginais} | {ok:false, adiar} |
 * {ok:false, erro, transitorio}).
 */
async function extrairUmSeguro(caseDir, rel, limites) {
  let buf;
  try {
    buf = readFileSync(join(caseDir, rel));
  } catch (err) {
    return { ok: false, erro: `ilegível (${err.code || err.message})`, transitorio: true };
  }
  try {
    const r = await extrairUm(caseDir, rel, buf, limites);
    if (r.adiar) return { ok: false, adiar: r.adiar };
    return { ok: true, sidecar: nomeSidecar(rel), detalhe: r.detalhe, avisos: r.avisos, novosOriginais: r.novosOriginais };
  } catch (err) {
    // dep ausente no node_modules não é defeito do arquivo: fora do cache negativo
    return { ok: false, erro: err.message, transitorio: err.transitorio === true || err.code === "ERR_MODULE_NOT_FOUND" };
  }
}

// Filho morto no meio da escrita deixa o tmp da escrita atômica para trás (o
// sufixo leva o pid DELE). Best-effort: o que sobrar não é elegível nem workdoc.
function limparTemporarios(caseDir, rel, pid) {
  if (!pid) return;
  const suf = sufixoTmp(pid);
  try {
    unlinkSync(join(caseDir, `${nomeSidecar(rel)}${suf}`));
  } catch {
    // não havia
  }
  try {
    const dir = join(caseDir, `${rel}${SUFIXO_ANEXOS}`);
    for (const n of readdirSync(dir)) if (n.endsWith(suf)) unlinkSync(join(dir, n));
  } catch {
    // sem pasta de anexos
  }
}

let contadorFilho = 0;

/**
 * Roda extrairUm num processo filho (este arquivo em modo `--arquivo`) e traduz
 * o fim dele num resultado. O resultado volta por ARQUIVO, não por stdout: as
 * libs dos leitores podem imprimir, e o stdout do filho é descartado. stderr é
 * capturado só para reconhecer a morte por falta de memória do V8.
 */
function extrairEmFilho(caseDir, rel, limites, { prazoMs, limitePorArquivoMs, dirResultados, spawn, maxHeapFilhoMb }) {
  const resultado = join(dirResultados, `${(contadorFilho += 1)}.json`);
  const args = [
    `--max-old-space-size=${maxHeapFilhoMb}`,
    CAMINHO_EXTRAIR,
    "--arquivo", join(caseDir, ...rel.split("/")),
    "--caso", caseDir,
    "--resultado", resultado,
    "--limites", JSON.stringify(limites),
  ];
  const r = spawn(process.execPath, args, {
    timeout: Math.max(1, Math.floor(prazoMs)),
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  try {
    if (r.error && r.error.code === "ETIMEDOUT") {
      limparTemporarios(caseDir, rel, r.pid);
      // cortado pelo que restava do orçamento, não pelo teto do arquivo: não é
      // defeito do arquivo, fica para a próxima rodada (e fora do cache negativo)
      if (prazoMs < limitePorArquivoMs) return { ok: false, adiar: "orçamento de tempo esgotado" };
      return { ok: false, erro: `tempo esgotado (${Math.round(limitePorArquivoMs / 1000)} s)` };
    }
    if (r.error && r.error.code !== "ENOBUFS") {
      return { ok: false, erro: `processo não iniciou (${r.error.message})`, transitorio: true };
    }
    if (r.error || r.status !== 0) {
      limparTemporarios(caseDir, rel, r.pid);
      if (/heap out of memory|Reached heap limit|Allocation failed/i.test(String(r.stderr || ""))) return { ok: false, erro: "memória insuficiente" };
      return { ok: false, erro: `processo falhou (${r.error ? "saída de erro excessiva" : r.status ?? r.signal})` };
    }
    try {
      return JSON.parse(readFileSync(resultado, "utf-8"));
    } catch {
      return { ok: false, erro: "processo falhou (sem resultado)" };
    }
  } finally {
    try {
      unlinkSync(resultado);
    } catch {
      // o filho não chegou a gravar
    }
  }
}

// ---------- cache negativo ----------

let versaoPluginMemo;
// Versão do plugin desta instalação: falha registrada por uma versão não vale
// para a seguinte (que pode ter consertado o leitor).
function versaoDoPlugin() {
  if (versaoPluginMemo === undefined) {
    try {
      versaoPluginMemo = String(JSON.parse(readFileSync(new URL("./.claude-plugin/plugin.json", import.meta.url), "utf-8")).version ?? "");
    } catch {
      versaoPluginMemo = "";
    }
  }
  return versaoPluginMemo;
}

/**
 * A falha registrada vale enquanto o arquivo é o mesmo: md5 igual; para o
 * original acima de 50 MiB, que nunca é lido (ler 500 MiB a cada tick para
 * saber que não vai extrair seria o custo que o teto evita), tamanho e mtime.
 */
function mesmaFalha(entrada, assinatura) {
  if (!entrada || typeof entrada !== "object" || entrada.plugin !== versaoDoPlugin()) return false;
  if (assinatura.md5) return entrada.md5 === assinatura.md5;
  return entrada.md5 == null && entrada.bytes === assinatura.bytes && entrada.mtimeMs === assinatura.mtimeMs;
}

function novaFalha(assinatura, motivo, agora) {
  const id = assinatura.md5 ? { md5: assinatura.md5 } : { md5: null, bytes: assinatura.bytes, mtimeMs: assinatura.mtimeMs };
  return { ...id, motivo, quando: new Date(agora()).toISOString(), plugin: versaoDoPlugin() };
}

/** Cache negativo da base; ausente ou corrompido vale {} (o pior caso é tentar de novo). */
export function carregarFalhas(casesBase) {
  try {
    const o = JSON.parse(readFileSync(join(casesBase, ARQUIVO_FALHAS), "utf-8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** Grava com chaves ordenadas e só quando muda (não acorda nada à toa a cada tick). */
export function gravarFalhas(casesBase, falhas) {
  const ordenado = {};
  for (const k of Object.keys(falhas).sort()) ordenado[k] = falhas[k];
  const path = join(casesBase, ARQUIVO_FALHAS);
  const texto = `${JSON.stringify(ordenado, null, 2)}\n`;
  let atual = null;
  try {
    atual = readFileSync(path, "utf-8");
  } catch {
    // ainda não existe
  }
  if (atual === texto || (atual === null && Object.keys(ordenado).length === 0)) return;
  escreverAtomico(path, texto);
}

function resumoVazio() {
  return { extraidos: [], adiados: [], grandes: [], pulados: 0, naoTocados: [], erros: [], falhasNovas: {}, falhasMantidas: [] };
}

/**
 * Extrai os originais de UM caso. Opções além dos tetos: `limitePorArquivoMs`
 * (90 s no tick, 45 s no hook), `maxBytesPorArquivo` (o hook não tenta original
 * acima de 5 MiB: fica para o tick), `falhas` (o cache negativo carregado por
 * quem chama; as entradas novas voltam em `resumo.falhasNovas` e as que
 * continuam valendo em `resumo.falhasMantidas`), `caso` (prefixo das chaves do
 * cache; padrão: o nome da pasta). Só para testes: `emProcesso` (extrai no
 * próprio processo, para injetar `agora()` no orçamento), `spawn` e
 * `maxHeapFilhoMb`.
 */
export async function extrairCaso(caseDir, opts = {}) {
  const {
    orcamentoMs = Infinity,
    agora = Date.now,
    log = () => {},
    maxOriginalBytes = MAX_ORIGINAL_BYTES,
    maxAnexoBytes = MAX_ANEXO_BYTES,
    maxSaidaBytes = MAX_SAIDA_BYTES,
    poolMaxSidecarBytes = POOL_MAX_SIDECAR_BYTES, // só o teste muda: o teto é do pool
    limitePorArquivoMs = LIMITE_POR_ARQUIVO_MS,
    maxBytesPorArquivo = Infinity,
    falhas = {},
    caso = basename(caseDir),
    emProcesso = false,
    spawn = spawnSync, // só testes trocam: simulam morte do filho sem esperar por ela
    maxHeapFilhoMb = MAX_HEAP_FILHO_MB,
  } = opts;
  const limites = { maxAnexoBytes, maxSaidaBytes, poolMaxSidecarBytes, maxBytesPorArquivo };
  const resumo = resumoVazio();
  const chave = (rel) => `${caso}/${rel}`;
  // falha conhecida: mantém a entrada; nova: registra; devolve se é nova
  const registrar = (rel, assinatura, motivo) => {
    const k = chave(rel);
    if (mesmaFalha(falhas[k], assinatura)) {
      resumo.falhasMantidas.push(k);
      return false;
    }
    resumo.falhasNovas[k] = novaFalha(assinatura, motivo, agora);
    return true;
  };
  // .md do usuário no lugar do sidecar: logado uma vez por conteúdo desse .md
  const naoTocado = (rel, sidecar, texto) => {
    const novo = registrar(sidecar, { md5: md5hex(Buffer.from(texto, "utf-8")) }, "sidecar do usuário, não tocado");
    resumo.naoTocados.push({ rel, sidecar, novo });
    if (novo) log(`${sidecar} é do usuário, não tocado`);
  };
  let dirResultados = null;
  try {
    const inicio = agora();
    const varredura = varrer(caseDir, { maxOriginalBytes });
    resumo.erros.push(...varredura.erros);
    for (const e of varredura.erros) log(`erro ${e.rel}: ${e.erro}`);
    for (const g of varredura.grandes) {
      const novo = registrar(g.rel, g, "acima do teto de 50 MiB");
      resumo.grandes.push({ rel: g.rel, bytes: g.bytes, novo });
      if (novo) log(`${g.rel} acima do teto de 50 MiB (${tamanhoLegivel(g.bytes)}), sem sidecar`);
    }
    const plano = planejarExtracao({ originais: varredura.originais, sidecars: varredura.sidecars });
    resumo.pulados = plano.pular.length;
    for (const { rel, sidecar } of plano.naoTocar) naoTocado(rel, sidecar, varredura.sidecars[sidecar]);
    // Fila em ordem de path: o e-mail vem antes da sua pasta `.anexos/`, então
    // um anexo que a varredura já viu (de rodada anterior) e que o e-mail acaba
    // de regravar é o mesmo item da fila — nunca extraído duas vezes. O filho
    // relê o arquivo do disco, então o item pendente já pega a versão nova.
    const fila = [];
    const naFila = new Map();
    const enfileirar = (rel, md5, bytes) => {
      // falha registrada para estes mesmos bytes: não tenta de novo nem loga
      if (mesmaFalha(falhas[chave(rel)], { md5 })) {
        resumo.falhasMantidas.push(chave(rel));
        resumo.pulados += 1;
        return;
      }
      if (bytes > maxBytesPorArquivo) {
        resumo.adiados.push({ rel, motivo: `grande demais para extrair agora (${tamanhoLegivel(bytes)})` });
        return;
      }
      const item = { rel, md5 };
      fila.push(item);
      naFila.set(rel, item);
    };
    for (const e of plano.extrair) enfileirar(e.rel, varredura.originais[e.rel].md5, varredura.originais[e.rel].bytes);
    while (fila.length) {
      const item = fila.shift();
      naFila.delete(item.rel);
      const decorrido = agora() - inicio;
      if (decorrido >= orcamentoMs) {
        resumo.adiados.push({ rel: item.rel, motivo: "orçamento de tempo esgotado" });
        continue;
      }
      let r;
      if (emProcesso) r = await extrairUmSeguro(caseDir, item.rel, limites);
      else {
        dirResultados ??= mkdtempSync(join(tmpdir(), "extracao-"));
        r = extrairEmFilho(caseDir, item.rel, limites, {
          prazoMs: Math.min(orcamentoMs - decorrido, limitePorArquivoMs),
          limitePorArquivoMs,
          dirResultados,
          spawn,
          maxHeapFilhoMb,
        });
      }
      if (r.adiar) {
        resumo.adiados.push({ rel: item.rel, motivo: r.adiar });
        continue;
      }
      if (!r.ok) {
        resumo.erros.push({ rel: item.rel, erro: r.erro });
        log(`erro ${item.rel}: ${r.erro}`);
        if (!r.transitorio) registrar(item.rel, { md5: item.md5 }, r.erro);
        continue;
      }
      resumo.extraidos.push({ rel: item.rel, sidecar: r.sidecar, detalhe: r.detalhe });
      log(`extraido ${item.rel} -> ${r.sidecar}`);
      // anexo recém-gravado entra na fila se o sidecar dele não estiver em dia
      for (const relAnexo of r.novosOriginais ?? []) {
        try {
          const buf = readFileSync(join(caseDir, relAnexo));
          const md5 = md5hex(buf);
          const pendente = naFila.get(relAnexo);
          if (pendente) {
            pendente.md5 = md5;
            continue;
          }
          const sc = nomeSidecar(relAnexo);
          const abs = join(caseDir, sc);
          const sidecars = existsSync(abs) ? { [sc]: readFileSync(abs, "utf-8") } : {};
          const p = planejarExtracao({ originais: { [relAnexo]: { md5, bytes: buf.length } }, sidecars });
          if (p.extrair.length) enfileirar(relAnexo, md5, buf.length);
          else if (p.pular.length) resumo.pulados += 1;
          else for (const n of p.naoTocar) naoTocado(n.rel, n.sidecar, sidecars[n.sidecar]);
        } catch (err) {
          resumo.erros.push({ rel: relAnexo, erro: `ilegível (${err.code || err.message})` });
        }
      }
    }
    for (const a of resumo.adiados) log(`adiado ${a.rel}: ${a.motivo}`);
  } catch (err) {
    // rede de segurança: o contrato é nunca lançar (hook e tick dependem disso)
    resumo.erros.push({ rel: ".", erro: err.message });
  } finally {
    if (dirResultados) {
      try {
        rmSync(dirResultados, { recursive: true, force: true });
      } catch {
        // tmp do sistema: o SO limpa
      }
    }
  }
  return resumo;
}

const TOPO_IGNORADOS = new Set(["_archive", "_template", "scripts"]);

/**
 * Todos os casos (subpastas diretas de casesBase), com o orçamento
 * compartilhado. Carrega e grava o cache negativo uma vez por chamada: o novo
 * cache são as entradas que continuaram valendo mais as novas, então a entrada
 * de arquivo que mudou, sumiu ou passou a extrair cai sozinha.
 */
export async function extrairTodos(casesBase, opts = {}) {
  const porCaso = {};
  const { orcamentoMs = Infinity, agora = Date.now } = opts;
  let casos;
  try {
    casos = readdirSync(casesBase, { withFileTypes: true })
      .filter((x) => x.isDirectory() && !x.name.startsWith(".") && !TOPO_IGNORADOS.has(x.name))
      .map((x) => x.name)
      .sort();
  } catch {
    // casesBase ausente ou ilegível: nada a extrair
    return { porCaso };
  }
  const falhas = opts.falhas ?? carregarFalhas(casesBase);
  const proximas = {};
  const inicio = agora();
  for (const nome of casos) {
    const restante = orcamentoMs === Infinity ? Infinity : Math.max(0, orcamentoMs - (agora() - inicio));
    const r = await extrairCaso(join(casesBase, nome), { ...opts, orcamentoMs: restante, falhas, caso: nome });
    porCaso[nome] = r;
    for (const k of r.falhasMantidas) proximas[k] = falhas[k];
    Object.assign(proximas, r.falhasNovas);
  }
  try {
    gravarFalhas(casesBase, proximas);
  } catch {
    // sem o cache, a próxima rodada só tenta de novo
  }
  return { porCaso };
}

// O resumo vai para o contexto do Claude a cada SessionStart: uma pasta com
// centenas de anexos não pode virar centenas de linhas.
const TETO_LINHAS_RESUMO = 40;

/**
 * Reparte `total` linhas entre listas de tamanhos dados: lista que cabe na
 * parte igual leva só o que precisa e a sobra vai para as maiores; empate de
 * resto vai para as primeiras na ordem de exibição.
 */
function repartir(tamanhos, total) {
  const cotas = tamanhos.map(() => 0);
  const pendentes = tamanhos.map((_, i) => i).sort((a, b) => tamanhos[a] - tamanhos[b] || a - b);
  let livre = total;
  while (pendentes.length) {
    const parte = Math.floor(livre / pendentes.length);
    if (tamanhos[pendentes[0]] <= parte) {
      const i = pendentes.shift();
      cotas[i] = tamanhos[i];
      livre -= tamanhos[i];
      continue;
    }
    let sobra = livre - parte * pendentes.length;
    for (const i of [...pendentes].sort((a, b) => a - b)) {
      cotas[i] = parte + (sobra > 0 ? 1 : 0);
      sobra -= 1;
    }
    break;
  }
  return cotas;
}

/**
 * Texto do hook: o que foi extraído, o que ficou para o sincronizador, o que
 * falhou e o que é grande demais (para quem lê ir ao original); "" quando as
 * quatro listas estão vazias. No máximo 40 linhas: a lista cortada termina em
 * "... e mais N".
 */
export function formatarResumo(r) {
  const listas = [
    ["Textos extraídos nesta pasta (leia o .md ao lado do original):", r.extraidos.map((e) => `- ${e.sidecar} (${e.detalhe})`)],
    ["Ficou para o sincronizador (não extraído agora):", r.adiados.map((a) => `- ${a.rel}: ${a.motivo}`)],
    ["Não foi possível extrair (leia o original):", r.erros.map((e) => `- ${e.rel}: ${e.erro}`)],
    ["Grandes demais para o extrator (leia o original):", (r.grandes ?? []).map((g) => `- ${g.rel} (${tamanhoLegivel(g.bytes)})`)],
  ].filter(([, itens]) => itens.length);
  if (!listas.length) return "";
  const cotas = repartir(listas.map(([, itens]) => itens.length), TETO_LINHAS_RESUMO - listas.length);
  const linhas = [];
  listas.forEach(([titulo, itens], i) => {
    linhas.push(titulo);
    if (itens.length <= cotas[i]) linhas.push(...itens);
    else linhas.push(...itens.slice(0, cotas[i] - 1), `... e mais ${itens.length - (cotas[i] - 1)}`);
  });
  return linhas.join("\n");
}

// Nada do filho pode ir para stdout/stderr além da morte do V8: as libs dos
// leitores imprimem (o msgreader faz console.debug em recorrência malformada).
function silenciarConsole() {
  for (const m of ["log", "debug", "info", "warn", "error", "trace", "dir"]) console[m] = () => {};
}

/** Modo filho: extrai UM original e grava o resultado em `--resultado`. */
async function mainArquivo(val) {
  silenciarConsole();
  const caseDir = val("--caso");
  let lim = {};
  try {
    lim = JSON.parse(val("--limites") ?? "{}") ?? {};
  } catch {
    // limites padrão
  }
  // JSON não tem Infinity: o teto ausente chega como null
  const limites = {
    maxAnexoBytes: lim.maxAnexoBytes ?? MAX_ANEXO_BYTES,
    maxSaidaBytes: lim.maxSaidaBytes ?? MAX_SAIDA_BYTES,
    poolMaxSidecarBytes: lim.poolMaxSidecarBytes ?? POOL_MAX_SIDECAR_BYTES,
    maxBytesPorArquivo: lim.maxBytesPorArquivo ?? Infinity,
  };
  const rel = relative(caseDir, val("--arquivo")).split(sep).join("/");
  const r = await extrairUmSeguro(caseDir, rel, limites);
  // se nem isto gravar, o exit code != 0 diz ao pai que não houve resultado
  writeFileSync(val("--resultado"), JSON.stringify(r));
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (val("--arquivo")) {
    await mainArquivo(val);
    return;
  }
  const soResumo = args.includes("--resumo");
  const orc = Number(val("--orcamento"));
  const opts = {
    orcamentoMs: Number.isFinite(orc) && orc >= 0 ? orc * 1000 : Infinity,
    log: (l) => {
      if (!soResumo) console.log(l);
    },
  };
  try {
    if (val("--caso")) {
      const r = await extrairCaso(val("--caso"), opts);
      if (soResumo) {
        const s = formatarResumo(r);
        if (s) console.log(s);
      }
    } else if (val("--todos")) {
      await extrairTodos(val("--todos"), opts);
    } else {
      console.log("uso: extrair.mjs --caso <dir> [--orcamento <s>] [--resumo] | --todos <casesBase> [--orcamento <s>]");
    }
  } catch (err) {
    console.log(`erro fatal: ${err.message}`);
  }
  // exit code sempre 0: hook e tick não podem falhar por causa da extração
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
