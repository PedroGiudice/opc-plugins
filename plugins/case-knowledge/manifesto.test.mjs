import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_CAP_CHARS, renderManifesto } from "./format.mjs";

// Manifesto em partes: autos grandes (falencia com 3.469 segmentos, RJ com
// 1.252 atos) passavam de 200 mil caracteres. Fixture sintetica no shape do
// documentos.yaml real: atos com anexos, corridas de expediente entre eles e
// data de juntada crescente.
function autosGrandes({ atos = 600, anexosPorAto = 2, expedientePorAto = 1 } = {}) {
  const documentos = [];
  let pagina = 1;
  for (let i = 0; i < atos; i++) {
    const dia = String(1 + (i % 28)).padStart(2, "0");
    const mes = String(1 + Math.floor(i / 28) % 12).padStart(2, "0");
    const ano = 2020 + Math.floor(i / (28 * 12));
    const data = `${ano}-${mes}-${dia}T00:00:00Z`;
    const ato = {
      segmento_id: `autos.json#p${String(pagina).padStart(4, "0")}`,
      peso: "ato", peca: i % 2 ? "peticao_diversa" : "decisao_interlocutoria",
      fls: [pagina, pagina + 1], data_juntada: data, chunks: 2,
      anexos: [],
    };
    pagina += 2;
    for (let a = 0; a < anexosPorAto; a++) {
      ato.anexos.push({
        segmento_id: `autos.json#p${String(pagina).padStart(4, "0")}`,
        peso: "anexo", peca: "outros_anexos", fls: [pagina, pagina], data_juntada: data, chunks: 1,
      });
      pagina += 1;
    }
    documentos.push(ato);
    for (let e = 0; e < expedientePorAto; e++) {
      documentos.push({
        segmento_id: `autos.json#p${String(pagina).padStart(4, "0")}`,
        peso: "expediente", peca: e % 2 ? "mandado" : "certidao", fls: [pagina, pagina],
        data_juntada: data, chunks: 1,
      });
      pagina += 1;
    }
  }
  return { caso: "falencia-grande", total_documentos: documentos.length * 2, documentos };
}

// Le o manifesto inteiro seguindo o "Continua ...: manifesto(a_partir: N)".
function lerTudo(manifesto, opcoes = {}) {
  const paginas = [];
  let aPartir = 1;
  while (aPartir !== null) {
    const texto = renderManifesto(manifesto, { ...opcoes, aPartir });
    paginas.push(texto);
    const m = /Continua[^\n]*manifesto\(a_partir: (\d+)/.exec(texto);
    aPartir = m ? Number(m[1]) : null;
    assert.ok(paginas.length < 500, "laco sem fim");
  }
  return paginas;
}

const ids = (texto) => [...texto.matchAll(/<([^<>\n]+#p\d+)>/g)].map((m) => m[1]);

test("manifesto que cabe no teto sai sem partes nem indice", () => {
  const m = autosGrandes({ atos: 5 });
  const texto = renderManifesto(m, {});
  assert.ok(texto.length <= OUTPUT_CAP_CHARS);
  assert.doesNotMatch(texto, /Parte \d+ de \d+/);
  assert.doesNotMatch(texto, /a_partir/);
});

test("manifesto grande: nenhuma parte passa do teto", () => {
  const m = autosGrandes();
  const paginas = lerTudo(m);
  assert.ok(paginas.length > 1, "deveria vir em partes");
  for (const [k, p] of paginas.entries()) {
    assert.ok(p.length <= OUTPUT_CAP_CHARS, `parte ${k + 1}: ${p.length} chars`);
  }
});

test("manifesto grande: lido pela continuacao, entrega todo segmento uma vez, na ordem", () => {
  const m = autosGrandes({ expedientePorAto: 0 });
  const esperado = m.documentos.flatMap((d) => [d.segmento_id, ...d.anexos.map((a) => a.segmento_id)]);
  const lidos = lerTudo(m).flatMap(ids);
  assert.deepEqual(lidos, esperado);
});

test("manifesto grande: o ato nunca sai separado dos seus anexos", () => {
  const m = autosGrandes({ atos: 400, anexosPorAto: 6 });
  for (const p of lerTudo(m)) {
    for (const d of m.documentos) {
      if (!p.includes(`<${d.segmento_id}>`)) continue;
      for (const a of d.anexos) {
        assert.ok(p.includes(`<${a.segmento_id}>`), `anexo ${a.segmento_id} fora da parte do ato`);
      }
    }
  }
});

test("manifesto grande: expediente colapsado nao se perde entre as partes", () => {
  const m = autosGrandes({ expedientePorAto: 3 });
  const total = m.documentos.filter((d) => d.peso === "expediente").length;
  let contados = 0;
  for (const p of lerTudo(m)) {
    for (const [, linha] of p.matchAll(/\[\+ expediente: ([^\]]+)\]/g)) {
      for (const [, n] of linha.matchAll(/(\d+) \w+/g)) contados += Number(n);
    }
  }
  assert.equal(contados, total);
});

test("manifesto grande: cabecalho diz a parte e as entradas, e o indice lista todas as partes por arquivo e folhas", () => {
  // Sem expediente: a fl. de um expediente recolhido nao aparece em linha propria.
  const m = autosGrandes({ expedientePorAto: 0 });
  const paginas = lerTudo(m);
  const n = paginas.length;
  const primeira = paginas[0];
  assert.match(primeira, new RegExp(`Parte 1 de ${n} \\(entradas 1-\\d+ de ${m.documentos.length}`));
  const indice = [...primeira.matchAll(/^ {2}parte (\d+): a_partir (\d+), (.+)$/gm)];
  assert.equal(indice.length, n);
  assert.equal(indice[0][2], "1");
  assert.match(indice[0][3], /^autos\.json, fls\. 1-\d+$/);
  // A parte k do indice abre exatamente onde a continuacao leva, e as folhas
  // do indice sao as da primeira e da ultima linha da parte.
  for (let k = 0; k < n; k++) {
    assert.match(paginas[k], new RegExp(`Parte ${k + 1} de ${n} \\(entradas ${indice[k][2]}-`));
    const fls = [...paginas[k].matchAll(/fls\. (\d+)-(\d+)  /g)];
    assert.equal(indice[k][3], `autos.json, fls. ${fls[0][1]}-${fls.at(-1)[2]}`);
  }
  assert.match(paginas.at(-1), /Última parte\./);
});

test("manifesto grande: parte que atravessa dois arquivos diz onde comeca e onde termina", () => {
  const a = autosGrandes({ atos: 300 });
  const b = autosGrandes({ atos: 300 });
  for (const d of b.documentos) {
    d.segmento_id = d.segmento_id.replace("autos.json", "volume 2.json");
    for (const x of d.anexos ?? []) x.segmento_id = x.segmento_id.replace("autos.json", "volume 2.json");
  }
  for (const d of a.documentos) d.nome = "autos.json";
  for (const d of b.documentos) d.nome = "volume 2.json";
  const m = { caso: "dois-volumes", total_documentos: 0, documentos: [...a.documentos, ...b.documentos] };
  const indice = [...renderManifesto(m, {}).matchAll(/^ {2}parte (\d+): a_partir (\d+), (.+)$/gm)].map((x) => x[3]);
  assert.ok(indice.some((l) => /^de autos\.json fls\. \d+ a volume 2\.json fls\. \d+$/.test(l)), indice.join("\n"));
  assert.match(indice.at(-1), /^volume 2\.json, fls\. \d+-\d+$/);
});

test("manifesto grande: a_partir no meio de uma parte comeca naquela entrada e respeita o teto", () => {
  const m = autosGrandes();
  const texto = renderManifesto(m, { aPartir: 301 });
  assert.ok(texto.length <= OUTPUT_CAP_CHARS);
  assert.match(texto, /Entradas 301-\d+ de/);
  const primeiroId = ids(texto)[0];
  assert.equal(primeiroId, m.documentos[300].segmento_id);
});

test("manifesto: a_partir alem do fim responde quantas entradas existem", () => {
  const m = autosGrandes({ atos: 5 });
  const texto = renderManifesto(m, { aPartir: 999 });
  assert.match(texto, new RegExp(`${m.documentos.length} entradas`));
  assert.doesNotMatch(texto, /</);
});

test("manifesto grande expandido: continuacao mantem expandir_expediente e numeracao das entradas", () => {
  const m = autosGrandes({ expedientePorAto: 2 });
  const primeira = renderManifesto(m, { expandirExpediente: true });
  assert.match(primeira, /Continua[^\n]*manifesto\(a_partir: \d+, expandir_expediente: true\)/);
  const esperado = m.documentos.flatMap((d) => [d.segmento_id, ...(d.anexos ?? []).map((a) => a.segmento_id)]);
  assert.deepEqual(lerTudo(m, { expandirExpediente: true }).flatMap(ids), esperado);
});

test("manifesto: ato sozinho maior que o teto sai inteiro, com os anexos", () => {
  const m = autosGrandes({ atos: 3, anexosPorAto: 400, expedientePorAto: 0 });
  const paginas = lerTudo(m);
  const esperado = m.documentos.flatMap((d) => [d.segmento_id, ...(d.anexos ?? []).map((a) => a.segmento_id)]);
  assert.deepEqual(paginas.flatMap(ids), esperado);
});

test("tool manifesto aceita a_partir e o repassa ao render", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./server.mjs", import.meta.url), "utf-8");
  const tool = src.slice(src.indexOf('"manifesto",'), src.indexOf("// Tool: metadata"));
  assert.match(tool, /a_partir:\s*z\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(tool, /renderManifesto\(yaml\.load\(bruto\),\s*\{[^}]*aPartir:\s*a_partir/s);
});
