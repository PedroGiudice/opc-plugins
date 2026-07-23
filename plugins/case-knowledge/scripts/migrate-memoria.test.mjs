import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLegacyMemFile,
  planMigration,
  migrationDest,
} from "./migrate-memoria.mjs";

// Subconjunto REAL das pastas de caso da cmr-002 (a lista completa o script LE
// do disco em runtime). Contem todos os destinos exigidos pelos casos abaixo,
// inclusive candidatos de ambiguidade (carlos-eduardo, piggpay_sfdc,
// salesforce-desktopsa) e casing misto (abrafarma-ML-Ifood).
const CASE_PATHS = [
  "bianka-salesforce",
  "comex-salesforce-acao-principal",
  "comex-salesforce-cumprimento-provisorio",
  "compassion",
  "giordana-danilo",
  "glenmark-elpconsultores",
  "glenmark-gestante-temporaria",
  "glenmark-gssa",
  "glenmark-rd-incineracao",
  "luiz-henrique-soares",
  "carlos-eduardo",
  "novartis-anais-prado",
  "novartis-hosp-dornelles",
  "novartis-medfarma",
  "odmgt-jf-beleza",
  "oxigenio-marli-marcon",
  "oxigenio-acao-retificacao",
  "piggpay_sfdc",
  "salesforce-central-beneficios",
  "salesforce-clinica-leite",
  "salesforce-clube-candeias",
  "salesforce-desktopsa",
  "salesforce-elements",
  "salesforce-facilita-pagamentos",
  "salesforce-fte",
  "salesforce-goias-esporte-clube",
  "salesforce-guilherme-fleury",
  "salesforce-hit-oficial",
  "salesforce-mourad-munir",
  "salesforce-ph-brasil",
  "salesforce-piggpay",
  "salesforce-plr",
  "salesforce-rhopen",
  "salesforce-vs-suprimentos",
  "abrafarma-ML-Ifood",
];

// EXATO: slug normalizado (`_`->`-`, lowercase) == pasta lowercase. Auto-aplica.
const EXACT = [
  ["project_bianka_salesforce.md", "bianka-salesforce"],
  ["project_comex_salesforce_acao_principal.md", "comex-salesforce-acao-principal"],
  ["project_giordana_danilo.md", "giordana-danilo"],
  ["project_glenmark_elpconsultores.md", "glenmark-elpconsultores"],
  ["project_glenmark_gestante_temporaria.md", "glenmark-gestante-temporaria"],
  ["project_glenmark_rd_incineracao.md", "glenmark-rd-incineracao"],
  ["project_odmgt_jf_beleza.md", "odmgt-jf-beleza"],
  ["project_salesforce_central_beneficios.md", "salesforce-central-beneficios"],
  ["project_salesforce_clinica_leite.md", "salesforce-clinica-leite"],
  ["project_salesforce_clube_candeias.md", "salesforce-clube-candeias"],
  ["project_salesforce_elements.md", "salesforce-elements"],
  ["project_salesforce_fte.md", "salesforce-fte"],
  ["project_salesforce_guilherme_fleury.md", "salesforce-guilherme-fleury"],
  ["project_salesforce_hit_oficial.md", "salesforce-hit-oficial"],
  ["project_salesforce_mourad_munir.md", "salesforce-mourad-munir"],
  ["project_salesforce_ph_brasil.md", "salesforce-ph-brasil"],
  ["project_salesforce_plr.md", "salesforce-plr"],
  ["project_salesforce_rhopen.md", "salesforce-rhopen"],
  ["project_salesforce_vs_suprimentos.md", "salesforce-vs-suprimentos"],
  ["project_abrafarma_ml_ifood.md", "abrafarma-ML-Ifood"], // casing misto, exato-normalizado
];

// FUZZY: resolve por scoring IDF/cobertura (NAO-exato, NAO-curado). E um PALPITE
// -- casePath e o chute, mas NAO auto-aplica (segurado p/ confirmacao do CEO).
const FUZZY = [
  ["project_glenmark_gssa_supply.md", "glenmark-gssa"],
  ["project_novartis_medfarma_execucao.md", "novartis-medfarma"],
  ["project_oxigenio_marli_querela.md", "oxigenio-marli-marcon"],
  ["project_oxigenio_retificacao.md", "oxigenio-acao-retificacao"],
  ["project_salesforce_goias.md", "salesforce-goias-esporte-clube"],
];

// CURADO LIMPO: mapeamento slug->caso confirmado por humano (o token distintivo
// do slug diverge do nome da pasta -- "attrus" nao aparece em "pagamentos").
// Auto-aplica (decisao humana, nao coincidencia lexical).
const CURATED = [
  ["project_salesforce_facilita_attrus.md", "salesforce-facilita-pagamentos"],
];

test("classifyLegacyMemFile: EXATO -> casePath + match 'exact'", () => {
  for (const [name, expected] of EXACT) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    assert.equal(r.kind, "project", `${name}: kind`);
    assert.equal(r.casePath, expected, `${name}: casePath`);
    assert.equal(r.match, "exact", `${name}: match exact`);
    assert.equal(r.ambiguous, undefined, `${name}: sem ambiguous`);
    assert.equal(r.orphan, undefined, `${name}: sem orphan`);
  }
});

test("classifyLegacyMemFile: FUZZY -> casePath (palpite) + match 'fuzzy' + score", () => {
  for (const [name, expected] of FUZZY) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    assert.equal(r.kind, "project", `${name}: kind`);
    assert.equal(r.casePath, expected, `${name}: casePath (palpite)`);
    assert.equal(r.match, "fuzzy", `${name}: match fuzzy`);
    assert.ok(r.score && typeof r.score.idf === "number", `${name}: score idf p/ dry-run`);
  }
});

test("classifyLegacyMemFile: CURADO LIMPO -> casePath + match 'curated'", () => {
  for (const [name, expected] of CURATED) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    assert.equal(r.kind, "project", `${name}: kind`);
    assert.equal(r.casePath, expected, `${name}: casePath`);
    assert.equal(r.match, "curated", `${name}: match curated`);
  }
});

test("classifyLegacyMemFile: bianka casa EXATO (caso nomeado do brief)", () => {
  const r = classifyLegacyMemFile("project_bianka_salesforce.md", CASE_PATHS);
  assert.equal(r.kind, "project");
  assert.equal(r.casePath, "bianka-salesforce");
  assert.equal(r.match, "exact");
});

test("classifyLegacyMemFile: glenmark_gssa_supply e FUZZY, nao exato (caso do brief)", () => {
  const r = classifyLegacyMemFile("project_glenmark_gssa_supply.md", CASE_PATHS);
  assert.equal(r.casePath, "glenmark-gssa");
  assert.equal(r.match, "fuzzy", "supply nao esta na pasta -> palpite, nao exato");
});

test("classifyLegacyMemFile: comex_agravo e AMBIGUO (caso nomeado do brief)", () => {
  const r = classifyLegacyMemFile("project_comex_salesforce_agravo.md", CASE_PATHS);
  assert.equal(r.kind, "project");
  assert.equal(r.casePath, undefined, "ambiguo nunca vira casePath");
  assert.equal(r.match, undefined, "ambiguo nao tem match");
  assert.ok(Array.isArray(r.ambiguous), "tem lista de candidatos");
  assert.ok(r.ambiguous.includes("comex-salesforce-acao-principal"));
  assert.ok(r.ambiguous.includes("comex-salesforce-cumprimento-provisorio"));
  assert.ok(r.ambiguous.length >= 2);
});

test("classifyLegacyMemFile: piggpay e AMBIGUO (salesforce-piggpay | piggpay_sfdc)", () => {
  const r = classifyLegacyMemFile("project_piggpay_salesforce.md", CASE_PATHS);
  assert.equal(r.casePath, undefined);
  assert.ok(Array.isArray(r.ambiguous));
  assert.ok(r.ambiguous.includes("salesforce-piggpay"));
  assert.ok(r.ambiguous.includes("piggpay_sfdc"));
});

test("classifyLegacyMemFile: novartis_hed e AMBIGUO entre os 3 novartis", () => {
  const r = classifyLegacyMemFile("project_novartis_hed_execucao.md", CASE_PATHS);
  assert.equal(r.casePath, undefined);
  assert.ok(Array.isArray(r.ambiguous));
  assert.equal(r.ambiguous.length, 3);
  assert.ok(r.ambiguous.includes("novartis-anais-prado"));
  assert.ok(r.ambiguous.includes("novartis-hosp-dornelles"));
  assert.ok(r.ambiguous.includes("novartis-medfarma"));
});

test("classifyLegacyMemFile: luiz_henrique e AMBIGUO (nao auto-resolve p/ soares)", () => {
  const r = classifyLegacyMemFile("project_luiz_henrique_demissao.md", CASE_PATHS);
  assert.equal(r.casePath, undefined, "NUNCA auto-resolver mesmo com match lexical forte");
  assert.ok(Array.isArray(r.ambiguous));
  assert.ok(r.ambiguous.includes("luiz-henrique-soares"));
});

test("classifyLegacyMemFile: desktop_salesforce_notificacoes NAO auto-resolve", () => {
  const r = classifyLegacyMemFile("project_desktop_salesforce_notificacoes.md", CASE_PATHS);
  assert.equal(r.casePath, undefined, "nao vira casePath");
  assert.ok(r.ambiguous !== undefined || r.orphan === true, "ambiguo ou orfao, nunca resolvido");
});

test("classifyLegacyMemFile: otsuka e ORFAO (caso nomeado do brief)", () => {
  const r = classifyLegacyMemFile("project_otsuka_primeq.md", CASE_PATHS);
  assert.equal(r.kind, "project");
  assert.equal(r.orphan, true);
  assert.equal(r.casePath, undefined, "orfao nunca vira casePath");
  assert.equal(r.ambiguous, undefined);
});

test("classifyLegacyMemFile: odmgt_contratos_modelo e AMBIGUO com candidato odmgt-jf-beleza (Fix 2)", () => {
  // EXISTE candidato no disco (odmgt-jf-beleza) -> exige decisao humana, nao e orfao.
  const r = classifyLegacyMemFile("project_odmgt_contratos_modelo.md", CASE_PATHS);
  assert.equal(r.kind, "project");
  assert.equal(r.orphan, undefined, "nao e mais orfao -- ha candidato no disco");
  assert.equal(r.casePath, undefined, "ambiguo nunca vira casePath");
  assert.ok(Array.isArray(r.ambiguous));
  assert.deepEqual(r.ambiguous, ["odmgt-jf-beleza"]);
});

test("classifyLegacyMemFile: as 3 compassion casam FUZZY na unica pasta compassion", () => {
  for (const name of [
    "project_compassion_do_brasil_ago2026.md",
    "project_compassion_estatuto_associacao.md",
    "project_compassion_lavagem_npos.md",
  ]) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    assert.equal(r.kind, "project", `${name}: kind`);
    assert.equal(r.casePath, "compassion", `${name}: casePath`);
    assert.equal(r.match, "fuzzy", `${name}: match fuzzy (nao exato)`);
  }
});

test("classifyLegacyMemFile: feedback_* -> kind feedback (pool, sem casePath)", () => {
  const r = classifyLegacyMemFile("feedback_sem_emojis.md", CASE_PATHS);
  assert.equal(r.kind, "feedback");
  assert.equal(r.casePath, undefined);
  assert.equal(r.orphan, undefined);
  assert.equal(r.ambiguous, undefined);
});

test("classifyLegacyMemFile: reference_* -> kind reference (NAO migra)", () => {
  for (const name of [
    "reference_docx_render_cmr002.md",
    "reference_gerar_carta_cmr.md",
    "reference_stj_vec_fonte.md",
  ]) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    assert.equal(r.kind, "reference", `${name}: kind`);
    assert.equal(r.casePath, undefined, `${name}: sem casePath`);
  }
});

test("classifyLegacyMemFile: MEMORY.md -> kind index (NAO migra)", () => {
  const r = classifyLegacyMemFile("MEMORY.md", CASE_PATHS);
  assert.equal(r.kind, "index");
  assert.equal(r.casePath, undefined);
});

test("classifyLegacyMemFile: arquivo fora de padrao -> kind other", () => {
  const r = classifyLegacyMemFile("qualquer-coisa.md", CASE_PATHS);
  assert.equal(r.kind, "other");
  assert.equal(r.casePath, undefined);
});

test("invariante de seguranca: ambiguo/orfao NUNCA produzem casePath nem match", () => {
  const ALL = [
    "project_comex_salesforce_agravo.md",
    "project_piggpay_salesforce.md",
    "project_desktop_salesforce_notificacoes.md",
    "project_novartis_hed_execucao.md",
    "project_luiz_henrique_demissao.md",
    "project_otsuka_primeq.md",
    "project_odmgt_contratos_modelo.md",
  ];
  for (const name of ALL) {
    const r = classifyLegacyMemFile(name, CASE_PATHS);
    if (r.ambiguous !== undefined || r.orphan === true) {
      assert.equal(r.casePath, undefined, `${name}: casePath deve ser undefined`);
      assert.equal(r.match, undefined, `${name}: match deve ser undefined`);
    }
  }
});

test("classifyLegacyMemFile: casePath resolvido sempre passa nos guards de seguranca", () => {
  // Uma pasta com nome inseguro (traversal) jamais deve virar destino.
  const unsafe = [...CASE_PATHS, "../escapa"];
  const r = classifyLegacyMemFile("project_escapa.md", unsafe);
  assert.notEqual(r.casePath, "../escapa");
});

test("planMigration: mapeia todos os nomes e conta por TIER de resolucao", () => {
  const names = [
    "project_bianka_salesforce.md", // exact
    "project_salesforce_facilita_attrus.md", // curated
    "project_salesforce_goias.md", // fuzzy
    "project_comex_salesforce_agravo.md", // ambiguous
    "project_otsuka_primeq.md", // orphan
    "feedback_sem_emojis.md", // feedback
    "reference_docx_render_cmr002.md", // reference
    "MEMORY.md", // index
    "solto.md", // other
  ];
  const { rows, counts } = planMigration(names, CASE_PATHS);
  assert.equal(rows.length, names.length);
  assert.equal(counts.exact, 1);
  assert.equal(counts.curated, 1);
  assert.equal(counts.fuzzy, 1);
  assert.equal(counts.ambiguous, 1);
  assert.equal(counts.orphan, 1);
  assert.equal(counts.feedback, 1);
  assert.equal(counts.reference, 1);
  assert.equal(counts.index, 1);
  assert.equal(counts.other, 1);
});

test("migrationDest: EXATO -> <base>/<caso>/.memoria/<autor>/<nome>", () => {
  const entry = { name: "project_bianka_salesforce.md", kind: "project", casePath: "bianka-salesforce", match: "exact" };
  const dest = migrationDest(entry, "/base", "autor42");
  assert.equal(dest, "/base/bianka-salesforce/.memoria/autor42/project_bianka_salesforce.md");
});

test("migrationDest: CURADO -> auto-migra (mesmo destino de projeto)", () => {
  const entry = { name: "project_salesforce_facilita_attrus.md", kind: "project", casePath: "salesforce-facilita-pagamentos", match: "curated" };
  const dest = migrationDest(entry, "/base", "a");
  assert.equal(dest, "/base/salesforce-facilita-pagamentos/.memoria/a/project_salesforce_facilita_attrus.md");
});

test("migrationDest: FUZZY NAO auto-migra -> null (excluido da lista a copiar)", () => {
  const entry = { name: "project_glenmark_gssa_supply.md", kind: "project", casePath: "glenmark-gssa", match: "fuzzy", score: { idf: 1, cov: 1 } };
  assert.equal(migrationDest(entry, "/base", "a"), null, "palpite fuzzy nunca copia sem confirmacao");
});

test("migrationDest: feedback -> .feedback/<autor>/ (dot, NUNCA _feedback)", () => {
  const entry = { name: "feedback_sem_emojis.md", kind: "feedback" };
  const dest = migrationDest(entry, "/base", "autor42");
  assert.equal(dest, "/base/.feedback/autor42/feedback_sem_emojis.md");
  assert.ok(dest.includes("/.feedback/"), "usa .feedback (dot) -- consumido pelo sync CMR-138");
  assert.ok(!dest.includes("/_feedback/"), "nunca _feedback");
});

test("migrationDest: ambiguo/orfao/reference/index/other -> null (nao migra)", () => {
  assert.equal(migrationDest({ name: "x.md", kind: "project", ambiguous: ["a", "b"] }, "/base", "a"), null);
  assert.equal(migrationDest({ name: "x.md", kind: "project", orphan: true }, "/base", "a"), null);
  assert.equal(migrationDest({ name: "reference_x.md", kind: "reference" }, "/base", "a"), null);
  assert.equal(migrationDest({ name: "MEMORY.md", kind: "index" }, "/base", "a"), null);
  assert.equal(migrationDest({ name: "y.md", kind: "other" }, "/base", "a"), null);
});
