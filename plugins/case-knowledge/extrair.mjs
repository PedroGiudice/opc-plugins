#!/usr/bin/env node
/**
 * Extração automática de texto dos workdocs — WIRING (disco + orçamento).
 *
 * Chamado pelo tick do sync (fase extrairTextos, antes do syncWorkdocs) e pelo
 * hook SessionStart (hooks/extracao-sessao.mjs). Toda decisão pura está em
 * extracao.mjs; aqui só varredura, md5, leitura dos bytes, escrita atômica e
 * orçamento de tempo.
 *
 * Nenhuma exceção escapa de extrairCaso/extrairTodos: falha de um arquivo vai
 * para `erros` e a varredura segue; nada é omitido calado (o que não foi
 * extraído aparece em `adiados`, `naoTocados` ou `erros`).
 *
 * Determinismo: nada que dependa de hora ou de máquina chega ao sidecar, e todo
 * caminho relativo usa `/` (também no Windows), para que a segunda rodada sobre
 * o mesmo original produza o mesmo arquivo byte a byte e o pool não o recircule.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, lstatSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isExcludedDirName, WORKDOC_MAX_DEPTH } from "./workdocs.mjs";
import { planejarExtracao, nomeSidecar, tipoDeFormato, ehOriginalElegivel, montarSidecar, renderDocx, renderXlsx, renderEmail, tamanhoLegivel } from "./extracao.mjs";
import { lerDocx } from "./extracao/docx.mjs";
import { lerXlsx } from "./extracao/xlsx.mjs";
import { lerEml, lerMsg } from "./extracao/email.mjs";

export const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
export const MAX_ANEXO_BYTES = 20 * 1024 * 1024;
export const MAX_SAIDA_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_NIVEL_ANEXO = 1;
const SUFIXO_ANEXOS = ".anexos";
const RESERVADOS_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Nome de anexo pode ser o assunto inteiro do e-mail (.msg aninhado): sem teto,
// um nome acima do limite do sistema de arquivos derrubaria a extração do
// e-mail todo (ENAMETOOLONG).
const MAX_NOME_ANEXO = 150;

// md5hex e escreverAtomico são cópias locais DE PROPÓSITO: importar de
// sync-cases.mjs criaria ciclo (sync-cases importa este módulo) e carregaria
// auth.mjs/@napi-rs/keyring em todo hook SessionStart, que só precisa extrair.
function md5hex(buf) {
  return createHash("md5").update(buf).digest("hex");
}

// Mesmo contrato do writeAtomic de sync-cases.mjs: tmp + rename; se o rename
// falha (destino aberto no Windows), o tmp é removido antes de relançar.
function escreverAtomico(path, conteudo) {
  const tmp = `${path}.sync-tmp`;
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
 * Varre o caso: originais elegíveis {rel: {md5, bytes}} e os textos dos
 * sidecars que existem ao lado deles. Só o .md que é sidecar de um original é
 * lido (o caso pode ter centenas de notas .md que não interessam aqui). Os
 * bytes dos originais NÃO ficam em memória: só o md5; quem for extraído é
 * relido (até 50 MiB por arquivo vezes o parque inteiro estouraria a RAM).
 * Não segue symlink: o dirent descreve a própria entrada.
 */
function varrer(caseDir, { maxOriginalBytes }) {
  const originais = {};
  // .md por nome SEM caixa: no NTFS `A.DOCX.MD` do usuário é o mesmo arquivo
  // que o `A.DOCX.md` que escreveríamos; precisa ser visto para não ser pisado
  const mds = new Map();
  const adiados = [];
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
      if (!ehOriginalElegivel(rel)) continue;
      try {
        const tamanho = statSync(abs).size;
        if (tamanho > maxOriginalBytes) {
          adiados.push({ rel, motivo: `acima do teto de 50 MiB (${tamanhoLegivel(tamanho)})` });
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
  return { originais, sidecars, adiados, erros };
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

async function extrairUm(caseDir, rel, buf, limites) {
  const tipo = tipoDeFormato(rel);
  const fonte = rel.slice(rel.lastIndexOf("/") + 1);
  let corpo;
  let avisos;
  let detalhe;
  const anexosGravados = [];
  if (tipo === "docx") {
    const d = lerDocx(buf);
    corpo = renderDocx(d);
    avisos = d.avisos;
    // parágrafos e tabelas trazem `segmentos`; revisor = autor de marca de revisão
    const revisores = new Set(d.blocos.flatMap((b) => (b.segmentos ?? []).filter((s) => s.marca).map((s) => s.autor)));
    detalhe = `${plural(revisores.size, "revisor", "revisores")}, ${plural(d.comentarios.length, "comentário", "comentários")}`;
  } else if (tipo === "xlsx") {
    const d = await lerXlsx(buf);
    avisos = d.avisos;
    corpo = renderXlsxNoTeto(d, limites.maxSaidaBytes, avisos);
    detalhe = plural(d.abas.filter((a) => !a.oculta).length, "aba", "abas");
  } else {
    const e = tipo === "eml" ? await lerEml(buf) : lerMsg(buf);
    avisos = e.avisos;
    const dirAnexos = `${rel}${SUFIXO_ANEXOS}`;
    const nivel = nivelDeAnexo(rel) + 1;
    const usados = new Set();
    let gravados = 0;
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
      mkdirSync(join(caseDir, dirAnexos), { recursive: true });
      // só grava se mudou: reescrever bytes iguais mudaria o mtime e acordaria o pool à toa
      if (!existsSync(destino) || !readFileSync(destino).equals(a.conteudo)) escreverAtomico(destino, a.conteudo);
      a.caminho = relAnexo;
      gravados += 1;
      if (ehOriginalElegivel(relAnexo)) anexosGravados.push({ rel: relAnexo, nivel, buf: a.conteudo });
    }
    corpo = renderEmail(e);
    detalhe = `${plural(e.anexos.length, "anexo", "anexos")}, ${plural(gravados, "extraído", "extraídos")}`;
  }
  const md = montarSidecar({ fonte, md5: md5hex(buf), bytes: buf.length, avisos, corpo });
  const destino = destinoSeguro(caseDir, nomeSidecar(rel));
  if (!destino) throw new Error("caminho do sidecar passa por symlink");
  escreverAtomico(destino, md);
  return { detalhe, anexosGravados };
}

function resumoVazio() {
  return { extraidos: [], adiados: [], pulados: 0, naoTocados: [], erros: [] };
}

export async function extrairCaso(caseDir, opts = {}) {
  const {
    orcamentoMs = Infinity,
    agora = Date.now,
    log = () => {},
    maxOriginalBytes = MAX_ORIGINAL_BYTES,
    maxAnexoBytes = MAX_ANEXO_BYTES,
    maxSaidaBytes = MAX_SAIDA_BYTES,
  } = opts;
  const limites = { maxAnexoBytes, maxSaidaBytes };
  const resumo = resumoVazio();
  try {
    const inicio = agora();
    const varredura = varrer(caseDir, { maxOriginalBytes });
    resumo.adiados.push(...varredura.adiados);
    resumo.erros.push(...varredura.erros);
    for (const e of varredura.erros) log(`erro ${e.rel}: ${e.erro}`);
    const plano = planejarExtracao({ originais: varredura.originais, sidecars: varredura.sidecars });
    resumo.pulados = plano.pular.length;
    resumo.naoTocados = plano.naoTocar.map(({ rel, sidecar }) => ({ rel, sidecar }));
    // Fila em ordem de path: o e-mail vem antes da sua pasta `.anexos/`, então
    // um anexo que a varredura já viu (de rodada anterior) e que o e-mail acaba
    // de regravar é o mesmo item da fila, atualizado — nunca extraído duas vezes.
    const fila = plano.extrair.map((e) => ({ rel: e.rel, nivel: nivelDeAnexo(e.rel), buf: null }));
    const naFila = new Map(fila.map((i) => [i.rel, i]));
    while (fila.length) {
      const item = fila.shift();
      naFila.delete(item.rel);
      if (item.nivel > MAX_NIVEL_ANEXO) {
        resumo.adiados.push({ rel: item.rel, motivo: `anexo de nível ${item.nivel}: só um nível de anexo é extraído` });
        continue;
      }
      if (agora() - inicio >= orcamentoMs) {
        resumo.adiados.push({ rel: item.rel, motivo: "orçamento de tempo esgotado" });
        continue;
      }
      try {
        const buf = item.buf ?? readFileSync(join(caseDir, item.rel));
        const { detalhe, anexosGravados } = await extrairUm(caseDir, item.rel, buf, limites);
        const sidecar = nomeSidecar(item.rel);
        resumo.extraidos.push({ rel: item.rel, sidecar, detalhe });
        log(`extraido ${item.rel} -> ${sidecar}`);
        // anexo recém-gravado entra na fila se o sidecar dele não estiver em dia
        for (const n of anexosGravados) {
          const pendente = naFila.get(n.rel);
          if (pendente) {
            pendente.buf = n.buf;
            continue;
          }
          const sc = nomeSidecar(n.rel);
          const abs = join(caseDir, sc);
          const sidecars = existsSync(abs) ? { [sc]: readFileSync(abs, "utf-8") } : {};
          const p = planejarExtracao({ originais: { [n.rel]: { md5: md5hex(n.buf), bytes: n.buf.length } }, sidecars });
          if (p.extrair.length) {
            fila.push(n);
            naFila.set(n.rel, n);
          } else if (p.pular.length) resumo.pulados += 1;
          else resumo.naoTocados.push(...p.naoTocar.map(({ rel, sidecar: s }) => ({ rel, sidecar: s })));
        }
      } catch (err) {
        resumo.erros.push({ rel: item.rel, erro: err.message });
        log(`erro ${item.rel}: ${err.message}`);
      }
    }
    for (const a of resumo.adiados) log(`adiado ${a.rel}: ${a.motivo}`);
  } catch (err) {
    // rede de segurança: o contrato é nunca lançar (hook e tick dependem disso)
    resumo.erros.push({ rel: ".", erro: err.message });
  }
  return resumo;
}

const TOPO_IGNORADOS = new Set(["_archive", "_template", "scripts"]);

/** Todos os casos (subpastas diretas de casesBase), com o orçamento compartilhado. */
export async function extrairTodos(casesBase, opts = {}) {
  const porCaso = {};
  const { orcamentoMs = Infinity, agora = Date.now } = opts;
  try {
    const inicio = agora();
    const casos = readdirSync(casesBase, { withFileTypes: true })
      .filter((x) => x.isDirectory() && !x.name.startsWith(".") && !TOPO_IGNORADOS.has(x.name))
      .map((x) => x.name)
      .sort();
    for (const nome of casos) {
      const restante = orcamentoMs === Infinity ? Infinity : Math.max(0, orcamentoMs - (agora() - inicio));
      porCaso[nome] = await extrairCaso(join(casesBase, nome), { ...opts, orcamentoMs: restante });
    }
  } catch {
    // casesBase ausente ou ilegível: nada a extrair
  }
  return { porCaso };
}

/** Texto do hook: o que foi extraído e o que ficou para o sincronizador; "" quando nenhum dos dois. */
export function formatarResumo(r) {
  if (!r.extraidos.length && !r.adiados.length) return "";
  const linhas = [];
  if (r.extraidos.length) {
    linhas.push("Textos extraídos nesta pasta (leia o .md ao lado do original):");
    for (const e of r.extraidos) linhas.push(`- ${e.sidecar} (${e.detalhe})`);
  }
  if (r.adiados.length) {
    linhas.push("Ficou para o sincronizador (não extraído agora):");
    for (const a of r.adiados) linhas.push(`- ${a.rel}: ${a.motivo}`);
  }
  return linhas.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
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
