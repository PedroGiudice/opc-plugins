import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateContent, previewResult, renderLines, buildCappedPayload, capContextChunks, renderDocumentChunks, detectaCollectionAusente, renderCaseSemBase } from "./format.mjs";

test("truncateContent: content curto retorna intacto", () => {
  const r = truncateContent("texto curto", 1200);
  assert.equal(r.text, "texto curto");
  assert.equal(r.truncated, false);
});

test("truncateContent: content longo trunca em fronteira de palavra com sufixo", () => {
  const content = "palavra ".repeat(300); // 2400 chars
  const r = truncateContent(content, 1200);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1200 + 6, `len=${r.text.length}`);
  assert.ok(r.text.endsWith(" […]"));
  const body = r.text.slice(0, -" […]".length);
  assert.ok(!body.endsWith("palavr"), "cortou no meio da palavra");
});

test("truncateContent: maxChars 0 desativa truncamento", () => {
  const content = "x".repeat(5000);
  const r = truncateContent(content, 0);
  assert.equal(r.text, content);
  assert.equal(r.truncated, false);
});

test("truncateContent: sem espaco proximo do corte, corta seco", () => {
  const content = "a".repeat(3000); // sem espacos
  const r = truncateContent(content, 1200);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1200 + 6);
});

test("previewResult: trunca content e adiciona content_len/content_truncated", () => {
  const original = { score: 0.9, chunk_id: "c1", content: "y".repeat(5000), peca: "inicial" };
  const out = previewResult(original, 1200);
  assert.equal(out.content_truncated, true);
  assert.equal(out.content_len, 5000);
  assert.ok(out.content.length < 5000);
  assert.equal(out.peca, "inicial"); // demais campos preservados
  // nao muta o original
  assert.equal(original.content.length, 5000);
  assert.equal(original.content_truncated, undefined);
});

test("previewResult: content curto retorna o mesmo objeto sem campos extras", () => {
  const original = { score: 0.9, chunk_id: "c1", content: "curto" };
  const out = previewResult(original, 1200);
  assert.equal(out, original);
});

test("previewResult: result sem content string retorna intacto", () => {
  const original = { score: 0.9, chunk_id: "c1" };
  assert.equal(previewResult(original, 1200), original);
});

// --- Task 2: renderLines + buildCappedPayload ---

test("renderLines: array vazio vira []", () => {
  assert.equal(renderLines([]), "[]");
});

test("renderLines: 1 objeto por linha, JSON parseavel", () => {
  const items = [{ a: 1 }, { b: "dois" }];
  const out = renderLines(items);
  assert.deepEqual(JSON.parse(out), items);
  const lines = out.split("\n");
  // formato: "[", "{...},", "{...}", "]"
  assert.equal(lines[0], "[");
  assert.equal(lines.at(-1), "]");
  assert.equal(lines.length, 4);
});

function makeResult(i, contentLen) {
  return {
    score: 0.9 - i * 0.01,
    chunk_id: `c${i}`,
    chunk_index: i,
    documento: "doc.json",
    peca: "inicial",
    content: ("palavra ".repeat(Math.ceil(contentLen / 8))).slice(0, contentLen),
  };
}

test("buildCappedPayload: payload pequeno passa sem degrade", () => {
  const lists = [[makeResult(0, 500), makeResult(1, 500)]];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(degraded, null);
  assert.ok(JSON.parse(text).length === 2);
});

test("buildCappedPayload: preview default aplicado (content 5000 -> ~1200)", () => {
  const lists = [[makeResult(0, 5000)]];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(degraded, null); // preview default NAO conta como degrade
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].content_truncated, true);
  assert.equal(parsed[0].content_len, 5000);
  assert.ok(parsed[0].content.length <= 1206);
});

test("buildCappedPayload: payload grande degrada preview progressivamente", () => {
  // 50 results de 8000 chars: com preview 1200 = ~60k+ chars -> degrada
  const lists = [Array.from({ length: 50 }, (_, i) => makeResult(i, 8000))];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 30000,
  });
  assert.ok(degraded !== null);
  assert.ok(text.length <= 30000, `len=${text.length}`);
});

test("buildCappedPayload: content_chars=0 nunca trunca content, corta cauda", () => {
  // 10 results de 30k chars cada, cap 65k -> precisa cortar pra ~2 results
  const lists = [Array.from({ length: 10 }, (_, i) => makeResult(i, 30000))];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 0,
    globalCap: 65000,
  });
  assert.ok(degraded !== null);
  assert.ok(degraded.kept !== null && degraded.kept < 10);
  const parsed = JSON.parse(text);
  // content integral preservado nos que sobraram
  assert.equal(parsed[0].content.length, 30000);
  assert.equal(parsed[0].content_truncated, undefined);
});

test("buildCappedPayload: melhor esforco quando nada cabe (nao lanca)", () => {
  const lists = [[makeResult(0, 200000)]];
  const { text } = buildCappedPayload({
    lists,
    render: (pls) => renderLines(pls[0]),
    contentChars: 0, // integra de 1 result gigante: impossivel caber
    globalCap: 1000,
  });
  assert.ok(typeof text === "string" && text.length > 0);
});

test("buildCappedPayload: multiplas listas (batch) cortadas em paralelo", () => {
  const lists = [
    Array.from({ length: 10 }, (_, i) => makeResult(i, 4000)),
    Array.from({ length: 10 }, (_, i) => makeResult(i + 10, 4000)),
  ];
  const { text, degraded } = buildCappedPayload({
    lists,
    render: (pls) => pls.map((l) => renderLines(l)).join("\n---\n"),
    contentChars: 1200,
    globalCap: 12000,
  });
  assert.ok(degraded !== null);
  assert.ok(text.length <= 12000);
});

// --- Task 3: capContextChunks ---

function makeChunk(idx, len) {
  return { chunk_index: idx, content: "z".repeat(len) };
}

test("capContextChunks: janela que cabe retorna intacta", () => {
  const chunks = [makeChunk(4, 1000), makeChunk(5, 1000), makeChunk(6, 1000)];
  const { chunks: out, reduced } = capContextChunks(chunks, 5, 60000);
  assert.equal(out.length, 3);
  assert.equal(reduced, false);
});

test("capContextChunks: remove extremidades mais distantes do central, preserva central", () => {
  // 7 chunks de 10k chars = 70k > cap 35k -> precisa dropar ~4
  const chunks = [2, 3, 4, 5, 6, 7, 8].map((i) => makeChunk(i, 10000));
  const { chunks: out, reduced } = capContextChunks(chunks, 5, 35000);
  assert.equal(reduced, true);
  assert.ok(out.some((c) => c.chunk_index === 5), "central removido");
  // os que sobram sao os mais proximos do central
  const indices = out.map((c) => c.chunk_index);
  const maxDist = Math.max(...indices.map((i) => Math.abs(i - 5)));
  const droppedMinDist = Math.min(
    ...[2, 3, 4, 5, 6, 7, 8].filter((i) => !indices.includes(i)).map((i) => Math.abs(i - 5))
  );
  assert.ok(maxDist <= droppedMinDist, "dropou chunk mais proximo que um mantido");
});

test("capContextChunks: central gigante sozinho nunca e removido", () => {
  const chunks = [makeChunk(5, 100000)];
  const { chunks: out } = capContextChunks(chunks, 5, 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].chunk_index, 5);
  assert.equal(out[0].content.length, 100000); // central jamais truncado
});

// --- Endurecimento de bordas (code review pos-Task 3) ---

test("truncateContent: sem espacos e maxChars pequeno nao perde conteudo alem do corte", () => {
  const content = "a".repeat(3000);
  const r = truncateContent(content, 50);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 50 + 4, `len=${r.text.length}`);
  const body = r.text.slice(0, -" […]".length);
  assert.equal(body, content.slice(0, 50), "corte seco deve preservar o prefixo inteiro");
});

test("truncateContent: maxChars NaN retorna intacto sem truncar", () => {
  const content = "x".repeat(100);
  const r = truncateContent(content, NaN);
  assert.equal(r.text, content);
  assert.equal(r.truncated, false);
});

test("buildCappedPayload: lists vazio nao lanca, degraded null", () => {
  const { text, degraded } = buildCappedPayload({
    lists: [],
    render: (pls) => "[]",
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(degraded, null);
  assert.equal(text, "[]");
});

test("buildCappedPayload: lista interna vazia nao lanca", () => {
  const { text } = buildCappedPayload({
    lists: [[]],
    render: (pls) => renderLines(pls[0]),
    contentChars: 1200,
    globalCap: 60000,
  });
  assert.equal(text, "[]");
});

test("capContextChunks: array vazio retorna vazio sem reduzir", () => {
  const { chunks, reduced } = capContextChunks([], 5, 60000);
  assert.deepEqual(chunks, []);
  assert.equal(reduced, false);
});

test("renderDocumentChunks: ordena por chunk_index e rende sequencial", () => {
  const out = renderDocumentChunks([
    { chunk_index: 2, content: "terceiro" },
    { chunk_index: 0, content: "primeiro" },
    { chunk_index: 1, content: "segundo" },
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.delivered, 3);
  assert.equal(out.delivered_from, 0);
  assert.equal(out.delivered_to, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.next_from, null);
  assert.match(out.text, /--- chunk 0 ---\nprimeiro[\s\S]*--- chunk 1 ---\nsegundo[\s\S]*--- chunk 2 ---\nterceiro/);
});

test("renderDocumentChunks: from_chunk filtra o inicio", () => {
  const out = renderDocumentChunks(
    [
      { chunk_index: 0, content: "a" },
      { chunk_index: 1, content: "b" },
      { chunk_index: 2, content: "c" },
    ],
    { fromChunk: 1 }
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.delivered_from, 1);
  assert.equal(out.total, 3);
  assert.ok(!out.text.includes("chunk 0"));
});

test("renderDocumentChunks: cap trunca e aponta next_from", () => {
  const big = "x".repeat(500);
  const chunks = Array.from({ length: 10 }, (_, i) => ({ chunk_index: i, content: big }));
  const out = renderDocumentChunks(chunks, { globalCap: 1200 });
  assert.equal(out.truncated, true);
  assert.equal(out.delivered, 2); // 2 chunks de ~540 cabem em 1200
  assert.equal(out.delivered_to, 1);
  assert.equal(out.next_from, 2);
});

test("renderDocumentChunks: primeiro chunk entra mesmo acima do cap", () => {
  const out = renderDocumentChunks(
    [{ chunk_index: 0, content: "y".repeat(5000) }],
    { globalCap: 100 }
  );
  assert.equal(out.delivered, 1);
  assert.equal(out.truncated, false);
});

test("renderDocumentChunks: from_chunk alem do fim retorna vazio sem lancar", () => {
  const out = renderDocumentChunks([{ chunk_index: 0, content: "a" }], { fromChunk: 99 });
  assert.equal(out.delivered, 0);
  assert.equal(out.delivered_from, null);
  assert.equal(out.next_from, null);
  assert.equal(out.total, 1);
});

// === CMR-146: caso sem base embedada (casca) ===
//
// Fixtures derivadas do codigo real da API Rust
// (case-docs `crates/case-ingest/src/bin/api.rs`):
//
//  - 404 de collection ausente: `ApiError::NotFound(format!("caso {case_name}
//    nao encontrado"))` + `#[error("not found: {0}")]` -> body
//    `{"error":"not found: caso <nome> nao encontrado"}`. Emitido por
//    search_handler, reconstruir_handler, info_handler e facet_handler.
//  - 500 de collection ausente: stats/document/contexto NAO passam pelo
//    `is_collection_not_found`; o erro cru do Qdrant sobe como
//    `ApiError::Internal` -> 500 com a mensagem do qdrant-client.
//  - 404 do gate de pertinencia (caso fora do tenant): mensagem BYTE-IDENTICA
//    a do 404 de collection; so a ROTA distingue (briefing/metadata/memoria
//    conferem o diretorio em disco, as rotas de collection nao).

test("detectaCollectionAusente: 404 de collection no search e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zz-casca nao encontrado" },
      "/cases/zz-casca/search"
    ),
    true
  );
});

test("detectaCollectionAusente: 404 de collection no reconstruir e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zz-casca nao encontrado" },
      "/cases/zz-casca/reconstruir"
    ),
    true
  );
});

test("detectaCollectionAusente: 500 do Qdrant \"doesn't exist\" no stats e casca", () => {
  // Mensagem real do qdrant-client (mesma fixture do teste Rust
  // `detecta_collection_not_found_do_qdrant`).
  assert.equal(
    detectaCollectionAusente(
      500,
      { error: "Collection `t1-case-zz-casca` doesn't exist!" },
      "/cases/zz-casca/stats"
    ),
    true
  );
});

test("detectaCollectionAusente: 500 status NotFound do Qdrant no contexto e casca", () => {
  // Fixture do teste Rust `detecta_collection_not_found_variante_not_found`.
  assert.equal(
    detectaCollectionAusente(
      500,
      { error: 'status: NotFound, message: "Collection not found"' },
      "/cases/zz-casca/contexto"
    ),
    true
  );
});

test("detectaCollectionAusente: 500 do Qdrant no document e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      500,
      { error: "Collection `t1-case-zz-casca` doesn't exist!" },
      "/cases/zz-casca/document/peticao%20inicial.json"
    ),
    true
  );
});

test("detectaCollectionAusente: 404 do gate de pertinencia NAO e casca", () => {
  // Caso fora do tenant / inexistente em disco. Body identico ao 404 de
  // collection; a rota (metadata, com gate de filesystem) e o unico sinal.
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zz-alheio nao encontrado" },
      "/cases/zz-alheio/metadata"
    ),
    false
  );
});

test("detectaCollectionAusente: 404 de briefing NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zz-alheio nao encontrado" },
      "/cases/zz-alheio/briefing"
    ),
    false
  );
});

test("detectaCollectionAusente: 404 de documento inexistente NAO e casca", () => {
  // Collection existe, o documento pedido e que nao esta la.
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: documento 'inexistente.json' nao encontrado" },
      "/cases/zz-ingerido/document/inexistente.json"
    ),
    false
  );
});

test("detectaCollectionAusente: 500 alheio (conexao) NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(500, { error: "connection refused" }, "/cases/zz/stats"),
    false
  );
});

test("detectaCollectionAusente: 500 de index faltando NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      500,
      { error: 'Index required but not found for "data_juntada" of one of the following types: [datetime]' },
      "/cases/zz/search"
    ),
    false
  );
});

test("detectaCollectionAusente: 401 e 403 NAO sao casca", () => {
  assert.equal(
    detectaCollectionAusente(401, { error: "unauthorized: bearer ausente" }, "/cases/zz/search"),
    false
  );
  assert.equal(
    detectaCollectionAusente(403, { error: "forbidden: scope invalido" }, "/cases/zz/search"),
    false
  );
});

test("detectaCollectionAusente: 200 nunca e casca", () => {
  assert.equal(detectaCollectionAusente(200, { results: [] }, "/cases/zz/search"), false);
});

test("detectaCollectionAusente: aceita body como string JSON crua", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      '{"error":"not found: caso zz-casca nao encontrado"}',
      "/cases/zz-casca/search"
    ),
    true
  );
});

test("detectaCollectionAusente: body nao-JSON cai no texto cru", () => {
  assert.equal(
    detectaCollectionAusente(500, "Collection `t1-case-zz` doesn't exist!", "/cases/zz/stats"),
    true
  );
  assert.equal(
    detectaCollectionAusente(502, "<html>bad gateway</html>", "/cases/zz/stats"),
    false
  );
});

test("detectaCollectionAusente: body ausente nunca e casca", () => {
  assert.equal(detectaCollectionAusente(404, null, "/cases/zz/search"), false);
  assert.equal(detectaCollectionAusente(404, undefined, "/cases/zz/search"), false);
});

test("detectaCollectionAusente: rota ausente nunca e casca", () => {
  assert.equal(
    detectaCollectionAusente(404, { error: "not found: caso zz nao encontrado" }, undefined),
    false
  );
});

test("renderCaseSemBase: texto honesto com nome do caso, memoria e workdocs", () => {
  const texto = renderCaseSemBase("zz-casca");
  assert.ok(texto.includes("zz-casca"), "cita o nome do caso");
  assert.ok(texto.includes("sem base embedada"));
  assert.ok(/n(a|ã)o foram extra/i.test(texto), "explica que os autos nao foram extraidos");
  assert.ok(/mem(o|ó)ria/i.test(texto), "diz que a memoria funciona");
  assert.ok(/workdocs/i.test(texto), "diz que workdocs funciona");
  assert.ok(/app/i.test(texto), "aponta o caminho de subir os autos pelo app");
  // Regra do repo: zero emojis no output.
  assert.ok(!/\p{Extended_Pictographic}/u.test(texto), "sem emojis");
});

// --- I1: o 404 tem de casar o NOME DO CASO, nao qualquer "caso ..." na frase ---
//
// O nome do documento e livre e cabe a palavra "caso" dentro dele. Sem ancorar
// no nome real (que vem do path), um documento inexistente num caso PLENAMENTE
// INGERIDO seria reportado como "sem base embedada" — mentira sobre autos que
// existem.

test("detectaCollectionAusente: 'caso' dentro de nome de documento NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: documento 'caso 123 - contrato.pdf' nao encontrado" },
      "/cases/zz-ok/document/caso%20123%20-%20contrato.pdf"
    ),
    false
  );
});

test("detectaCollectionAusente: 'do caso N' dentro de nome de documento NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: documento 'Autos do caso 5 fls 1-40.json' nao encontrado" },
      "/cases/zz-ok/document/Autos%20do%20caso%205%20fls%201-40.json"
    ),
    false
  );
});

test("detectaCollectionAusente: nome real com hifen e ponto segue sendo casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso glenmark-r.d-incineracao nao encontrado" },
      "/cases/glenmark-r.d-incineracao/search"
    ),
    true
  );
});

test("detectaCollectionAusente: ponto do nome nao vira coringa de regex", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zzXcasca nao encontrado" },
      "/cases/zz.casca/search"
    ),
    false
  );
});

test("detectaCollectionAusente: nome do caso divergente do path NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso outro-caso nao encontrado" },
      "/cases/zz-casca/search"
    ),
    false
  );
});

test("detectaCollectionAusente: sobra de texto depois da mensagem NAO e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso zz-casca nao encontrado no documento X" },
      "/cases/zz-casca/search"
    ),
    false
  );
});

test("detectaCollectionAusente: nome do caso com espaco (path cru) e casca", () => {
  assert.equal(
    detectaCollectionAusente(
      404,
      { error: "not found: caso Novartis Anais Prado nao encontrado" },
      "/cases/Novartis Anais Prado/search"
    ),
    true
  );
});

test("detectaCollectionAusente: path com % invalido nao lanca", () => {
  // decodeURIComponent lancaria URIError; o detector cai no nome cru.
  assert.doesNotThrow(() =>
    detectaCollectionAusente(
      404,
      { error: "not found: caso 100%-casca nao encontrado" },
      "/cases/100%-casca/search"
    )
  );
});
