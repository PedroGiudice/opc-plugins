import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReconstrucao } from "./format.mjs";

// --- Helpers locais (fixtures do ReconstruirResponse) ---
// Espelham skip_serializing_if do Rust: campos Option omitidos quando None;
// copia_externa omitido quando false; matched sempre presente (bool).

function makeChunk(chunk_index, opts = {}) {
  const {
    content,
    page_start,
    page_end,
    matched = false,
    score,
    copia_externa,
    token_count = 100,
  } = opts;
  const c = { chunk_index, content: content ?? `conteudo do chunk ${chunk_index}`, token_count, matched };
  if (page_start != null) c.page_start = page_start;
  if (page_end != null) c.page_end = page_end;
  if (score != null) c.score = score;
  if (copia_externa) c.copia_externa = true;
  return c;
}

function makeFaixa(chunks, opts = {}) {
  const { gap_antes = 0 } = opts;
  const start = chunks[0].chunk_index;
  const end = chunks[chunks.length - 1].chunk_index;
  return { start, end, gap_antes, chunks };
}

function makeDoc(opts = {}) {
  const {
    documento = "doc.json",
    peca,
    doc_order,
    data_juntada,
    numero_processo,
    total_chunks,
    gap_final = 0,
    score_max = 0.9,
    matched_count = 1,
    faixas = [],
  } = opts;
  const maxIdx = faixas.length
    ? Math.max(...faixas.flatMap((f) => f.chunks.map((c) => c.chunk_index)))
    : -1;
  const d = {
    documento,
    total_chunks: total_chunks ?? maxIdx + 1 + gap_final,
    gap_final,
    score_max,
    matched_count,
    faixas,
  };
  if (peca != null) d.peca = peca;
  if (doc_order != null) d.doc_order = doc_order;
  if (data_juntada != null) d.data_juntada = data_juntada;
  if (numero_processo != null) d.numero_processo = numero_processo;
  return d;
}

function makeResp(opts = {}) {
  const {
    query = "venda casada",
    modo = "focado",
    janela = 2,
    documentos = [],
    recall_hits = 0,
    documentos_no_recall,
    total_chunks_retornados = 0,
    truncado = false,
    query_ms = 5,
  } = opts;
  return {
    query,
    modo,
    janela,
    documentos,
    recall_hits,
    documentos_no_recall: documentos_no_recall ?? documentos.length,
    total_chunks_retornados,
    truncado,
    query_ms,
  };
}

// --- 15 casos obrigatorios ---

test("1: documentos vazio -> mensagem fixa, degraded null", () => {
  const r = renderReconstrucao(makeResp({ documentos: [] }));
  assert.equal(r.text, "Nenhum documento reconstruido para essa busca.");
  assert.equal(r.degraded, null);
});

test("2: doc unico faixa completa -> header sem elipse, degraded null", () => {
  const chunks = [
    makeChunk(0, { page_start: 1, page_end: 13, content: "AAA" }),
    makeChunk(1, { page_start: 14, page_end: 27, content: "BBB", matched: true, score: 0.9 }),
    makeChunk(2, { page_start: 28, page_end: 40, content: "CCC" }),
  ];
  const doc = makeDoc({
    documento: "doc.json",
    peca: "contestacao",
    data_juntada: "2024-07-18",
    total_chunks: 3,
    gap_final: 0,
    faixas: [makeFaixa(chunks, { gap_antes: 0 })],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(
    r.text.includes("## contestacao — 18/07/2024 — fls. 1-40 — `doc.json`"),
    r.text
  );
  assert.ok(!r.text.includes("[... "), "nao deve haver elipse de omissao");
  assert.equal(r.degraded, null);
});

test("3: gap antes com paginas conhecidas -> fls. 1-5 omitidas", () => {
  const chunks = [
    makeChunk(5, { page_start: 6, page_end: 6, content: "F5", matched: true, score: 0.8 }),
    makeChunk(6, { page_start: 7, page_end: 7, content: "F6" }),
  ];
  const doc = makeDoc({
    peca: "sentenca",
    data_juntada: "2024-01-10",
    total_chunks: 7,
    gap_final: 0,
    faixas: [makeFaixa(chunks, { gap_antes: 5 })],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(r.text.includes("[... fls. 1-5 omitidas ...]"), r.text);
});

test("4: gap entre faixas (paginas +1/-1) e singular para 1 pagina", () => {
  const fa = makeFaixa(
    [makeChunk(0, { page_start: 1, page_end: 11, content: "A", matched: true, score: 0.9 })],
    { gap_antes: 0 }
  );
  const fb = makeFaixa(
    [makeChunk(30, { page_start: 39, page_end: 39, content: "B", matched: true, score: 0.7 })],
    { gap_antes: 29 }
  );
  const doc = makeDoc({
    peca: "contestacao",
    data_juntada: "2024-03-03",
    total_chunks: 31,
    gap_final: 0,
    faixas: [fa, fb],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(r.text.includes("[... fls. 12-38 omitidas ...]"), r.text);

  // singular: gap de exatamente 1 pagina -> "omitida"
  const g1 = makeDoc({
    peca: "despacho",
    data_juntada: "2024-03-03",
    total_chunks: 3,
    gap_final: 0,
    faixas: [
      makeFaixa([makeChunk(0, { page_start: 5, page_end: 5, content: "X", matched: true, score: 0.9 })]),
      makeFaixa([makeChunk(2, { page_start: 7, page_end: 7, content: "Y", matched: true, score: 0.8 })], {
        gap_antes: 1,
      }),
    ],
  });
  const r2 = renderReconstrucao(makeResp({ documentos: [g1], documentos_no_recall: 1 }));
  assert.ok(r2.text.includes("[... fls. 6 omitida ...]"), r2.text);
});

test("5: gap final -> elipse ao fim (upper desconhecido, trecho count)", () => {
  const chunks = [makeChunk(0, { page_start: 1, page_end: 3, content: "AAA", matched: true, score: 0.9 })];
  const doc = makeDoc({
    peca: "inicial",
    data_juntada: "2024-05-05",
    total_chunks: 8,
    gap_final: 7,
    faixas: [makeFaixa(chunks)],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(r.text.includes("[... 7 trechos omitidos ...]"), r.text);
  assert.ok(
    r.text.indexOf("[... 7 trechos omitidos ...]") > r.text.indexOf("AAA"),
    "elipse deve vir ao fim, apos o conteudo"
  );
});

test("6: chunk matched -> marcador antes do content, sem score; vizinho sem marcador", () => {
  const chunks = [
    makeChunk(7, { page_start: 7, page_end: 7, content: "VIZINHO_TXT" }),
    makeChunk(8, { page_start: 8, page_end: 8, content: "MATCHED_TXT", matched: true, score: 0.87 }),
  ];
  const doc = makeDoc({
    peca: "contestacao",
    data_juntada: "2024-06-06",
    total_chunks: 9,
    gap_final: 0,
    faixas: [makeFaixa(chunks, { gap_antes: 7 })],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(
    r.text.includes("[trecho localizado pela busca — fls. 8]\nMATCHED_TXT"),
    r.text
  );
  assert.ok(!r.text.includes("0.87"), "score nao deve aparecer no corpo");
  assert.ok(
    !r.text.includes("[trecho localizado pela busca — fls. 7]"),
    "vizinho nao deve ter marcador de match"
  );
});

test("7: copia_externa -> rotulo antes do content", () => {
  const chunks = [
    makeChunk(0, { page_start: 1, page_end: 1, content: "COPIA_TXT", copia_externa: true }),
  ];
  const doc = makeDoc({
    peca: "inicial",
    data_juntada: "2024-06-06",
    total_chunks: 1,
    gap_final: 0,
    faixas: [makeFaixa(chunks)],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(
    r.text.includes("[copia reproduzida nos autos — nao integra a peca]\nCOPIA_TXT"),
    r.text
  );
});

test("8: data null -> 'data nao identificada'; paginas null -> trecho fallback, sem fls", () => {
  const chunks = [makeChunk(3, { content: "SEM_PAGINA" })]; // sem page_start/page_end
  const doc = makeDoc({
    peca: "peticao",
    data_juntada: null,
    total_chunks: 5,
    gap_final: 1,
    faixas: [makeFaixa(chunks, { gap_antes: 3 })],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  assert.ok(r.text.includes("data nao identificada"), r.text);
  assert.ok(r.text.includes("[... 3 trechos omitidos ...]"), r.text);
  assert.ok(!/fls\./.test(r.text), "nunca inventa fls quando paginas sao null");
});

test("9: multi-doc -> contadores 'Documento N de M', separador ---, ordem preservada", () => {
  const d1 = makeDoc({
    documento: "d1.json",
    peca: "inicial",
    data_juntada: "2024-01-01",
    total_chunks: 1,
    faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 2, content: "DOC1", matched: true, score: 0.95 })])],
  });
  const d2 = makeDoc({
    documento: "d2.json",
    peca: "contestacao",
    data_juntada: "2024-02-02",
    total_chunks: 1,
    faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 2, content: "DOC2", matched: true, score: 0.85 })])],
  });
  const r = renderReconstrucao(makeResp({ documentos: [d1, d2], documentos_no_recall: 2 }));
  assert.ok(r.text.includes("Documento 1 de 2"), r.text);
  assert.ok(r.text.includes("Documento 2 de 2"), r.text);
  assert.ok(r.text.includes("\n---\n"), "separador --- entre documentos");
  assert.ok(r.text.indexOf("DOC1") < r.text.indexOf("DOC2"), "ordem do array preservada");
  assert.equal(r.degraded, null);
});

test("10: rodape rust-omit (documentos_no_recall - documentos da resposta)", () => {
  const docs = [
    makeDoc({
      documento: "a.json",
      peca: "inicial",
      data_juntada: "2024-01-01",
      total_chunks: 1,
      faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 1, content: "A", matched: true, score: 0.9 })])],
    }),
    makeDoc({
      documento: "b.json",
      peca: "contestacao",
      data_juntada: "2024-02-02",
      total_chunks: 1,
      faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 1, content: "B", matched: true, score: 0.8 })])],
    }),
  ];
  const r = renderReconstrucao(makeResp({ documentos: docs, documentos_no_recall: 5 }));
  assert.ok(
    r.text.includes(
      "[aviso: 3 outro(s) documento(s) com trechos relevantes nao reconstruido(s) (limite max_documentos). Aumente max_documentos ou filtre por peca.]"
    ),
    r.text
  );
  assert.equal(r.degraded, null);
});

test("11: degrade por faixas -> faixas_omitidas > 0, text <= cap, aviso de tokens", () => {
  const faixas = [0, 10, 20, 30].map((idx, i) =>
    makeFaixa(
      [
        makeChunk(idx, {
          page_start: idx + 1,
          page_end: idx + 1,
          content: `FAIXA${i}_` + "x".repeat(400),
          matched: true,
          score: 0.9 - i * 0.1,
        }),
      ],
      { gap_antes: i === 0 ? 0 : 9 }
    )
  );
  const doc = makeDoc({
    peca: "contestacao",
    data_juntada: "2024-01-01",
    total_chunks: 31,
    gap_final: 0,
    faixas,
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }), {
    globalCap: 800,
  });
  assert.ok(r.degraded !== null, "esperava degrade");
  assert.ok(r.degraded.faixas_omitidas > 0, JSON.stringify(r.degraded));
  assert.ok(r.text.length <= 800, `len=${r.text.length}`);
  assert.ok(/limite de tokens/.test(r.text), "aviso de limite de tokens no rodape");
});

test("12: degrade por documentos -> documentos_omitidos > 0, text <= cap", () => {
  const mk = (name, score, txt) =>
    makeDoc({
      documento: name,
      peca: "contestacao",
      data_juntada: "2024-01-01",
      total_chunks: 1,
      faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 1, content: txt, matched: true, score })])],
    });
  const docs = [
    mk("a.json", 0.9, "AAA" + "a".repeat(500)),
    mk("b.json", 0.8, "BBB" + "b".repeat(500)),
    mk("c.json", 0.7, "CCC" + "c".repeat(500)),
  ];
  const r = renderReconstrucao(makeResp({ documentos: docs, documentos_no_recall: 3 }), {
    globalCap: 900,
  });
  assert.ok(r.degraded !== null, "esperava degrade");
  assert.ok(r.degraded.documentos_omitidos > 0, JSON.stringify(r.degraded));
  assert.ok(r.text.length <= 900, `len=${r.text.length}`);
});

test("13: INVARIANTE -> todo chunk presente tem content COMPLETO como substring", () => {
  const docs = [];
  for (let d = 0; d < 3; d++) {
    const faixas = [];
    for (let f = 0; f < 3; f++) {
      const idx = f * 10;
      const content = `S${d}_${f}` + "m".repeat(300) + `E${d}_${f}`;
      faixas.push(
        makeFaixa(
          [
            makeChunk(idx, {
              page_start: idx + 1,
              page_end: idx + 1,
              content,
              matched: true,
              score: 0.9 - d * 0.1 - f * 0.01,
            }),
          ],
          { gap_antes: f === 0 ? 0 : 9 }
        )
      );
    }
    docs.push(
      makeDoc({
        documento: `d${d}.json`,
        peca: "contestacao",
        data_juntada: "2024-01-01",
        total_chunks: 21,
        gap_final: 0,
        faixas,
      })
    );
  }
  const r = renderReconstrucao(makeResp({ documentos: docs, documentos_no_recall: 3 }), {
    globalCap: 1500,
  });
  assert.ok(r.degraded !== null, "esperava degrade");
  for (let d = 0; d < 3; d++) {
    for (let f = 0; f < 3; f++) {
      const content = `S${d}_${f}` + "m".repeat(300) + `E${d}_${f}`;
      if (r.text.includes(`S${d}_${f}`)) {
        assert.ok(r.text.includes(content), `chunk ${d}_${f} truncado no meio`);
      }
    }
  }
});

test("14: best-effort -> chunk matched gigante nao lanca, text nao-vazio, content intacto", () => {
  const giant = "G".repeat(200000);
  const doc = makeDoc({
    peca: "inicial",
    data_juntada: "2024-01-01",
    total_chunks: 1,
    gap_final: 0,
    faixas: [makeFaixa([makeChunk(0, { page_start: 1, page_end: 1, content: giant, matched: true, score: 0.99 })])],
  });
  let r;
  assert.doesNotThrow(() => {
    r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }), { globalCap: 1000 });
  });
  assert.ok(r.text.length > 0, "text nao-vazio");
  assert.ok(r.text.includes(giant), "content do matched intacto");
});

test("15: dedupe defensivo -> chunk_index repetido nao duplica content", () => {
  const chunks = [
    makeChunk(0, { page_start: 1, page_end: 1, content: "REPEATED_UNIQUE_XYZ", matched: true, score: 0.9 }),
    makeChunk(0, { page_start: 1, page_end: 1, content: "REPEATED_UNIQUE_XYZ", matched: true, score: 0.9 }),
  ];
  const doc = makeDoc({
    peca: "inicial",
    data_juntada: "2024-01-01",
    total_chunks: 1,
    gap_final: 0,
    faixas: [makeFaixa(chunks)],
  });
  const r = renderReconstrucao(makeResp({ documentos: [doc], documentos_no_recall: 1 }));
  const occurrences = r.text.split("REPEATED_UNIQUE_XYZ").length - 1;
  assert.equal(occurrences, 1, r.text);
});
