# -*- coding: utf-8 -*-
"""Redline OOXML: marcas de revisão (w:ins / w:del) sobre o .docx ORIGINAL.

Princípio: o documento devolvido à contraparte é o arquivo dela, com a mesma
formatação, mais as nossas marcas. Por isso a biblioteca:

- reescreve SÓ `word/document.xml`; todas as outras partes do pacote (estilos,
  numeração, cabeçalhos, mídia, comentários) são copiadas byte a byte, na mesma
  ordem;
- edita por TEXTO VIVO (o que se lê com as marcas de terceiros já aplicadas),
  localizando parágrafos por trecho único, nunca por índice frágil;
- nunca toca em `w:ins`/`w:del` de outro autor: esses blocos são opacos;
- novos parágrafos herdam o `pPr` (numeração, recuo, espaçamento) do parágrafo
  modelo, então o Word renumera sozinho ao aceitar;
- falha alto em XML que não reconhece (token desconhecido), em vez de engolir.

Uso como biblioteca:

    from redline_docx import Redline, verificar
    r = Redline("minuta.docx", autor="CMR Advogados")
    r.editar("prazo máximo de", "()", "30 (trinta)")
    r.inserir("Foro da Comarca", "Belo Horizonte", ", Estado de Minas Gerais")
    r.substituir("cláusula 7.1", "7.1. Nova redação integral.")
    r.excluir("9.4.3")
    r.novo_paragrafo(modelo="9.5", texto="9.6. Parágrafo novo com **negrito**.")
    r.salvar("minuta - redline CMR.docx")
    assert verificar("minuta.docx", "minuta - redline CMR.docx") == []

Uso como CLI (ver `--help`): radiografia, aplicar (JSON de operações),
verificar, texto.

Limitações conhecidas (v1): parágrafos dentro de tabelas não são editáveis
(tabelas são blocos opacos); runs com tabulação, quebra de linha ou campo são
opacos para edição (o texto deles não entra no texto vivo); hiperlinks,
conteúdo controlado (sdt) e smart tags também são opacos.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import difflib
import html
import json
import re
import sys
import zipfile
from pathlib import Path

__all__ = ["Redline", "texto_aceito", "texto_rejeitado", "texto_vivo", "verificar", "radiografia"]

_TOKEN = re.compile(
    r"<w:pPr>.*?</w:pPr>|<w:pPr/>"
    r"|<w:ins\b[^>]*>.*?</w:ins>|<w:del\b[^>]*>.*?</w:del>"
    r"|<w:moveFrom\b[^>]*>.*?</w:moveFrom>|<w:moveTo\b[^>]*>.*?</w:moveTo>"
    r"|<w:hyperlink\b[^>]*>.*?</w:hyperlink>|<w:fldSimple\b[^>]*>.*?</w:fldSimple>"
    r"|<w:sdt>.*?</w:sdt>|<w:smartTag\b[^>]*>.*?</w:smartTag>|<w:customXml\b[^>]*>.*?</w:customXml>"
    r"|<w:r\b[^>]*>.*?</w:r>|<w:r/>"
    r"|<[^>]+/>",
    re.S,
)
_ITEM = re.compile(r"<w:p\b[^>]*/>|<w:p\b[^>]*>.*?</w:p>|<w:tbl>.*?</w:tbl>|<w:sdt>.*?</w:sdt>|<w:bookmark(?:Start|End)[^>]*/>|<w:sectPr\b[^>]*>.*?</w:sectPr>|<w:proofErr[^>]*/>|<w:customXml\b[^>]*>.*?</w:customXml>", re.S)
_T = re.compile(r"<w:t(?: [^>]*)?>([^<]*)</w:t>|<w:t/>")
_DELT = re.compile(r"<w:delText(?: [^>]*)?>([^<]*)</w:delText>|<w:delText/>")
_MARCA = re.compile(r'<w:(ins|del|moveFrom|moveTo)\b[^>]*?w:author="([^"]*)"')
_ID = re.compile(r'\bw:id="(\d+)"')


def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def _agora() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _split_rpr(inner: str) -> tuple[str, str]:
    """Separa o <w:rPr> inicial (com aninhamentos, ex. rPrChange) do resto do run."""
    if inner.startswith("<w:rPr/>"):
        return "", inner[len("<w:rPr/>"):]
    if not inner.startswith("<w:rPr>"):
        return "", inner
    depth, pos = 0, 0
    for m in re.finditer(r"<w:rPr>|</w:rPr>", inner):
        depth += 1 if m.group(0) == "<w:rPr>" else -1
        if depth == 0:
            pos = m.end()
            break
    return inner[:pos], inner[pos:]


def _run_parts(run: str) -> tuple[str, str] | None:
    """(rPr, texto) para run simples: só w:t (um ou mais) e quebras de página renderizadas."""
    m = re.match(r"<w:r\b[^>]*>(.*)</w:r>$", run, re.S)
    if not m:
        return None
    rpr, content = _split_rpr(m.group(1))
    content = content.replace("<w:lastRenderedPageBreak/>", "")
    if not content:
        return rpr, ""
    if not re.fullmatch(r"(?:<w:t(?: [^>]*)?>[^<]*</w:t>|<w:t/>)+", content):
        return None
    return rpr, html.unescape("".join(t for t in _T.findall(content)))


def _limpar_rpr(rpr: str) -> str:
    rpr = re.sub(r"<w:rPrChange\b.*?</w:rPrChange>", "", rpr, flags=re.S)
    rpr = re.sub(r"<w:(?:ins|del)\b[^>]*/>", "", rpr)
    return rpr


def _com_negrito(rpr: str) -> str:
    if not rpr or rpr == "<w:rPr/>":
        return "<w:rPr><w:b/><w:bCs/></w:rPr>"
    if "<w:b/>" in rpr or "<w:b " in rpr:
        return rpr
    for ancora in (r"<w:rFonts\b[^>]*/>", r"<w:rStyle\b[^>]*/>"):
        m = re.search(ancora, rpr)
        if m:
            return rpr[: m.end()] + "<w:b/><w:bCs/>" + rpr[m.end():]
    return rpr.replace("<w:rPr>", "<w:rPr><w:b/><w:bCs/>", 1)


def _mk_run(rpr: str, texto: str, excluido: bool = False) -> str:
    tag = "w:delText" if excluido else "w:t"
    return f'<w:r>{rpr}<{tag} xml:space="preserve">{_esc(texto)}</{tag}></w:r>'


def _novos_runs(texto: str, rpr_base: str, excluido: bool = False) -> str:
    """Texto com **negrito** -> runs herdando rpr_base."""
    base = _limpar_rpr(rpr_base)
    out = []
    for parte in re.split(r"(\*\*[^*]+\*\*)", texto):
        if not parte:
            continue
        negrito = parte.startswith("**") and parte.endswith("**")
        if negrito:
            parte = parte[2:-2]
        out.append(_mk_run(_com_negrito(base) if negrito else base, parte, excluido))
    return "".join(out)


def _tokenizar(par: str) -> tuple[str, list[str], str]:
    m = re.match(r"(<w:p\b[^>]*>)(.*)(</w:p>)$", par, re.S)
    if not m:
        raise ValueError("não é parágrafo: " + par[:80])
    abre, inner, fecha = m.groups()
    toks, pos = [], 0
    for t in _TOKEN.finditer(inner):
        if t.start() != pos:
            raise ValueError("token desconhecido: " + inner[pos:t.start()][:160])
        toks.append(t.group(0))
        pos = t.end()
    if pos != len(inner):
        raise ValueError("sobra não reconhecida: " + inner[pos:][:160])
    return abre, toks, fecha


def _ppr_tem_marca(par: str, tipo: str) -> bool:
    m = re.match(r"<w:p\b[^>]*>(<w:pPr>.*?</w:pPr>)?", par, re.S)
    ppr = m.group(1) if m and m.group(1) else ""
    m2 = re.search(r"<w:rPr>(.*?)</w:rPr>", ppr, re.S)
    return bool(m2 and re.search(rf"<w:{tipo}\b[^>]*/>", m2.group(1)))


def _texto_par(par: str, modo: str) -> str | None:
    """modo: vivo (fora de marcas), aceito, rejeitado."""
    if par.startswith("<w:p") and par.endswith("/>"):
        return ""
    if modo == "aceito" and _ppr_tem_marca(par, "del"):
        _, toks, _ = _tokenizar(par)
        if not any(t.startswith("<w:r") and _T.search(t) for t in toks):
            return None
    if modo == "rejeitado" and _ppr_tem_marca(par, "ins"):
        return None
    _, toks, _ = _tokenizar(par)
    s = []
    for t in toks:
        if t.startswith("<w:ins") or t.startswith("<w:moveTo"):
            if modo == "aceito":
                s.append(html.unescape("".join(_T.findall(t))))
        elif t.startswith("<w:del") or t.startswith("<w:moveFrom"):
            if modo == "rejeitado":
                s.append(html.unescape("".join(_DELT.findall(t))))
        elif t.startswith("<w:r"):
            s.append(html.unescape("".join(_T.findall(t))))
    return "".join(s)


def _ler_pacote(caminho) -> tuple[list[zipfile.ZipInfo], dict[str, bytes]]:
    with zipfile.ZipFile(caminho) as z:
        infos = z.infolist()
        dados = {i.filename: z.read(i.filename) for i in infos}
    return infos, dados


def _itens(xml: str) -> tuple[str, list[str], str]:
    ini = xml.find("<w:body>")
    if ini < 0:
        raise ValueError("document.xml sem <w:body>")
    ini += len("<w:body>")
    fim = xml.rfind("<w:sectPr")
    if fim < 0:
        fim = xml.rfind("</w:body>")
    head, body, tail = xml[:ini], xml[ini:fim], xml[fim:]
    itens, pos = [], 0
    for m in _ITEM.finditer(body):
        if m.start() != pos:
            raise ValueError("body com bloco não reconhecido: " + body[pos:m.start()][:160])
        itens.append(m.group(0))
        pos = m.end()
    if pos != len(body):
        raise ValueError("sobra no body: " + body[pos:][:160])
    return head, itens, tail


def _textos(caminho, modo: str) -> list[str | None]:
    _, dados = _ler_pacote(caminho)
    _, itens, _ = _itens(dados["word/document.xml"].decode("utf-8"))
    out: list[str | None] = []
    for it in itens:
        if it.startswith("<w:p"):
            out.append(_texto_par(it, modo))
        elif it.startswith("<w:tbl"):
            out.append(None)
    return out


def texto_vivo(caminho) -> list[str | None]:
    return _textos(caminho, "vivo")


def texto_aceito(caminho) -> list[str | None]:
    return _textos(caminho, "aceito")


def texto_rejeitado(caminho) -> list[str | None]:
    return _textos(caminho, "rejeitado")


def verificar(original, redline) -> list[dict]:
    """Rejeitar todas as marcas do redline deve devolver exatamente o original.

    Retorna lista de divergências (vazia = ok). Pega alteração feita sem marca,
    o erro invisível na visão "aceito".
    """
    a = [t for t in texto_rejeitado(original) if t is not None]
    b = [t for t in texto_rejeitado(redline) if t is not None]
    div = []
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        la, lb = a[i1:i2], b[j1:j2]
        for k in range(max(len(la), len(lb))):
            div.append({
                "indice_original": i1 + k if k < len(la) else None,
                "original": la[k] if k < len(la) else None,
                "rejeitado": lb[k] if k < len(lb) else None,
            })
    return div


class Redline:
    """Aplica marcas de revisão sobre o document.xml original."""

    def __init__(self, caminho, autor: str, data: str | None = None):
        self.caminho = Path(caminho)
        self.autor = autor
        self.data = data or _agora()
        self._infos, self._dados = _ler_pacote(self.caminho)
        xml = self._dados["word/document.xml"].decode("utf-8")
        self._head, self._itens, self._tail = _itens(xml)
        ids = [int(x) for x in _ID.findall(xml)]
        self._id = max(ids) + 1000 if ids else 5000
        self._apos: dict[int, list[str]] = {}

    # ---------------------------------------------------------------- leitura
    def _nid(self) -> str:
        self._id += 1
        return str(self._id)

    def paragrafos(self) -> list[str | None]:
        return [_texto_par(it, "vivo") if it.startswith("<w:p") else None for it in self._itens]

    def localizar(self, onde) -> int:
        """Índice do único parágrafo cujo texto vivo contém `onde` (int passa direto)."""
        if isinstance(onde, int):
            return onde
        achados = [i for i, t in enumerate(self.paragrafos()) if t and onde in t]
        if len(achados) != 1:
            raise ValueError(f"trecho {onde!r}: {len(achados)} parágrafos (precisa ser exatamente 1)")
        return achados[0]

    # --------------------------------------------------------------- helpers
    def _ins(self, inner: str) -> str:
        return f'<w:ins w:id="{self._nid()}" w:author="{_esc(self.autor)}" w:date="{self.data}">{inner}</w:ins>'

    def _del(self, inner: str) -> str:
        return f'<w:del w:id="{self._nid()}" w:author="{_esc(self.autor)}" w:date="{self.data}">{inner}</w:del>'

    def _marca_ppr(self, ppr: str, tipo: str) -> str:
        tag = f'<w:{tipo} w:id="{self._nid()}" w:author="{_esc(self.autor)}" w:date="{self.data}"/>'
        if ppr in ("", "<w:pPr/>"):
            return f"<w:pPr><w:rPr>{tag}</w:rPr></w:pPr>"
        if "<w:rPr>" in ppr:
            return ppr.replace("<w:rPr>", "<w:rPr>" + tag, 1)
        for ancora in ("<w:sectPr", "<w:pPrChange"):
            k = ppr.find(ancora)
            if k >= 0:
                return ppr[:k] + f"<w:rPr>{tag}</w:rPr>" + ppr[k:]
        return ppr.replace("</w:pPr>", f"<w:rPr>{tag}</w:rPr></w:pPr>")

    @staticmethod
    def _rpr_primeiro_run(toks: list[str]) -> str:
        for t in toks:
            if t.startswith("<w:r"):
                rp = _run_parts(t)
                if rp:
                    return rp[0]
        return ""

    # -------------------------------------------------------------- operações
    def editar(self, onde, de: str, para: str, ocorrencia: int = 1) -> None:
        """Troca `de` (texto vivo) por `para` com marca; `para` vazio = exclusão pura."""
        if not de:
            raise ValueError("`de` não pode ser vazio; use inserir()")
        i = self.localizar(onde)
        abre, toks, fecha = _tokenizar(self._itens[i])
        vivo = _texto_par(self._itens[i], "vivo") or ""
        idx = -1
        for _ in range(ocorrencia):
            idx = vivo.find(de, idx + 1)
            if idx < 0:
                raise ValueError(f"não achei {de!r} em {vivo[:120]!r}")
        ini, fim = idx, idx + len(de)
        out, pos, inserido = [], 0, not para
        for t in toks:
            rp = _run_parts(t) if t.startswith("<w:r") else None
            if not rp:
                out.append(t)
                continue
            rpr, texto = rp
            a, b = pos, pos + len(texto)
            pos = b
            if b <= ini or a >= fim or not texto:
                out.append(t)
                continue
            pre = texto[: max(0, ini - a)]
            meio = texto[max(0, ini - a): min(len(texto), fim - a)]
            pos_ = texto[min(len(texto), fim - a):]
            if pre:
                out.append(_mk_run(rpr, pre))
            if meio:
                out.append(self._del(_mk_run(rpr, meio, True)))
            if b >= fim and not inserido:
                out.append(self._ins(_novos_runs(para, rpr)))
                inserido = True
            if pos_:
                out.append(_mk_run(rpr, pos_))
        if not inserido:
            raise ValueError("inserção não posicionada (trecho cruza run opaco?)")
        self._itens[i] = abre + "".join(out) + fecha

    def inserir(self, onde, ancora: str, texto: str, depois: bool = True) -> None:
        """Insere `texto` logo após (ou antes de) `ancora`, sem apagar nada."""
        i = self.localizar(onde)
        abre, toks, fecha = _tokenizar(self._itens[i])
        vivo = _texto_par(self._itens[i], "vivo") or ""
        idx = vivo.find(ancora)
        if idx < 0:
            raise ValueError(f"não achei âncora {ancora!r} em {vivo[:120]!r}")
        alvo = idx + len(ancora) if depois else idx
        out, pos, feito = [], 0, False
        for t in toks:
            rp = _run_parts(t) if t.startswith("<w:r") else None
            if not rp or feito or not rp[1]:
                out.append(t)
                continue
            rpr, txt = rp
            a, b = pos, pos + len(txt)
            pos = b
            if a <= alvo <= b:
                k = alvo - a
                if txt[:k]:
                    out.append(_mk_run(rpr, txt[:k]))
                out.append(self._ins(_novos_runs(texto, rpr)))
                if txt[k:]:
                    out.append(_mk_run(rpr, txt[k:]))
                feito = True
            else:
                out.append(t)
        if not feito:
            raise ValueError("âncora não posicionada")
        self._itens[i] = abre + "".join(out) + fecha

    def substituir(self, onde, texto: str) -> None:
        """Apaga todo o texto vivo do parágrafo e insere `texto`."""
        i = self.localizar(onde)
        abre, toks, fecha = _tokenizar(self._itens[i])
        rpr_base = self._rpr_primeiro_run(toks)
        out = []
        for t in toks:
            rp = _run_parts(t) if t.startswith("<w:r") else None
            if rp and rp[1]:
                out.append(self._del(_mk_run(rp[0], rp[1], True)))
            else:
                out.append(t)
        out.append(self._ins(_novos_runs(texto, rpr_base)))
        self._itens[i] = abre + "".join(out) + fecha

    def excluir(self, onde) -> None:
        """Exclui o parágrafo inteiro (runs + marca de parágrafo)."""
        i = self.localizar(onde)
        abre, toks, fecha = _tokenizar(self._itens[i])
        out, tem_ppr = [], False
        for t in toks:
            if t.startswith("<w:pPr"):
                out.append(self._marca_ppr(t, "del"))
                tem_ppr = True
            elif t.startswith("<w:r"):
                rp = _run_parts(t)
                out.append(self._del(_mk_run(rp[0], rp[1], True)) if rp and rp[1] else t)
            else:
                out.append(t)
        if not tem_ppr:
            out.insert(0, self._marca_ppr("", "del"))
        self._itens[i] = abre + "".join(out) + fecha

    def novo_paragrafo(self, modelo, texto: str, apos=None, ilvl: int | None = None,
                       recuo: int | None = None, quebra_pagina: bool = False) -> None:
        """Parágrafo novo, integralmente inserido, herdando o pPr do `modelo`.

        Entra logo após `apos` (default: após o próprio modelo); chamadas
        sucessivas com o mesmo `apos` mantêm a ordem.
        """
        i_modelo = self.localizar(modelo)
        i_apos = self.localizar(apos) if apos is not None else i_modelo
        m = re.match(r"<w:p\b[^>]*>(<w:pPr>.*?</w:pPr>)?", self._itens[i_modelo], re.S)
        ppr = (m.group(1) if m and m.group(1) else "")
        ppr = re.sub(r"<w:pPrChange\b.*?</w:pPrChange>", "", ppr, flags=re.S)
        ppr = re.sub(r"<w:(?:ins|del)\b[^>]*/>", "", ppr)
        if ilvl is not None:
            ppr = re.sub(r'<w:ilvl w:val="\d+"/>', f'<w:ilvl w:val="{ilvl}"/>', ppr)
        if recuo is not None:
            if "w:left=" in ppr:
                ppr = re.sub(r' w:left="\d+"', f' w:left="{recuo}"', ppr)
            elif "<w:ind " in ppr:
                ppr = ppr.replace("<w:ind ", f'<w:ind w:left="{recuo}" ', 1)
        ppr = self._marca_ppr(ppr, "ins")
        _, toks, _ = _tokenizar(self._itens[i_modelo])
        rpr_base = self._rpr_primeiro_run(toks)
        runs = ('<w:r><w:br w:type="page"/></w:r>' if quebra_pagina else "") + _novos_runs(texto, rpr_base)
        self._apos.setdefault(i_apos, []).append(f"<w:p>{ppr}{self._ins(runs)}</w:p>")

    # --------------------------------------------------------------- saída
    def _xml(self) -> str:
        corpo = []
        for i, it in enumerate(self._itens):
            corpo.append(it)
            corpo.extend(self._apos.get(i, []))
        return self._head + "".join(corpo) + self._tail

    def estatisticas(self) -> dict:
        xml = self._xml()
        autores: dict[str, int] = {}
        for _tipo, autor in _MARCA.findall(xml):
            autores[html.unescape(autor)] = autores.get(html.unescape(autor), 0) + 1
        return {
            "ins": len(re.findall(r"<w:ins\b", xml)),
            "del": len(re.findall(r"<w:del\b", xml)),
            "autores": autores,
        }

    def salvar(self, saida) -> Path:
        saida = Path(saida)
        novo = self._xml().encode("utf-8")
        with zipfile.ZipFile(saida, "w") as z:
            for info in self._infos:
                dados = novo if info.filename == "word/document.xml" else self._dados[info.filename]
                zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zi.compress_type = info.compress_type
                zi.external_attr = info.external_attr
                z.writestr(zi, dados)
        return saida


# ------------------------------------------------------------------ radiografia
_PLACEHOLDERS = re.compile(r"X{3,}|\[●[^\]]*\]|●|\(\s*\)|_{3,}|\[[A-ZÀ-Ú][A-ZÀ-Ú ]{2,}\]|\[\s*\]")


def radiografia(caminho) -> dict:
    """Marcas por autor, comentários, placeholders e parágrafos numerados."""
    infos, dados = _ler_pacote(caminho)
    xml = dados["word/document.xml"].decode("utf-8")
    autores: dict[str, dict[str, int]] = {}
    for tipo, autor in _MARCA.findall(xml):
        autores.setdefault(html.unescape(autor), {}).setdefault(tipo, 0)
        autores[html.unescape(autor)][tipo] += 1
    comentarios = []
    if "word/comments.xml" in dados:
        cx = dados["word/comments.xml"].decode("utf-8")
        for m in re.finditer(r'<w:comment\b[^>]*w:author="([^"]*)"[^>]*>(.*?)</w:comment>', cx, re.S):
            comentarios.append({"autor": html.unescape(m.group(1)), "texto": html.unescape("".join(_T.findall(m.group(2))))[:200]})
    _, itens, _ = _itens(xml)
    pars, placeholders = [], []
    for i, it in enumerate(itens):
        if it.startswith("<w:tbl"):
            pars.append({"i": i, "tabela": True})
            continue
        if not it.startswith("<w:p"):
            continue
        txt = _texto_par(it, "vivo") or ""
        m = re.search(r'<w:numPr>.*?<w:ilvl w:val="(\d+)"/>.*?<w:numId w:val="(\d+)"/>', it, re.S)
        pars.append({"i": i, "texto": txt, "numPr": (m.group(2), m.group(1)) if m else None,
                     "marcas_terceiro": bool(re.search(r"<w:(?:ins|del)\b", it))})
        for ph in _PLACEHOLDERS.findall(txt):
            placeholders.append({"i": i, "placeholder": ph, "contexto": txt[:120]})
    sect = re.search(r"<w:sectPr\b.*?</w:sectPr>", xml, re.S)
    pg = re.search(r'<w:pgSz w:w="(\d+)" w:h="(\d+)"', sect.group(0)) if sect else None
    fonte = None
    if "word/styles.xml" in dados:
        sx = dados["word/styles.xml"].decode("utf-8")
        m = re.search(r"<w:docDefaults>.*?<w:rFonts[^>]*w:ascii=\"([^\"]*)\".*?</w:docDefaults>", sx, re.S)
        sz = re.search(r"<w:docDefaults>.*?<w:sz w:val=\"(\d+)\".*?</w:docDefaults>", sx, re.S)
        fonte = {"ascii": m.group(1) if m else None, "pt": int(sz.group(1)) / 2 if sz else None}
    return {
        "arquivo": str(caminho),
        "partes": [i.filename for i in infos],
        "marcas_por_autor": autores,
        "comentarios": comentarios,
        "placeholders": placeholders,
        "paragrafos": pars,
        "pagina_twips": {"w": int(pg.group(1)), "h": int(pg.group(2))} if pg else None,
        "fonte_padrao": fonte,
    }


# ------------------------------------------------------------------------ CLI
_OPS = {
    "editar": lambda r, o: r.editar(o["onde"], o["de"], o.get("para", ""), o.get("ocorrencia", 1)),
    "inserir": lambda r, o: r.inserir(o["onde"], o["ancora"], o["texto"], o.get("depois", True)),
    "substituir": lambda r, o: r.substituir(o["onde"], o["texto"]),
    "excluir": lambda r, o: r.excluir(o["onde"]),
    "novo_paragrafo": lambda r, o: r.novo_paragrafo(o["modelo"], o["texto"], o.get("apos"), o.get("ilvl"),
                                                     o.get("recuo"), o.get("quebra_pagina", False)),
}


def _cli(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Redline OOXML sobre .docx original (marcas de revisão).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("radiografia", help="marcas por autor, comentários, placeholders, parágrafos")
    a.add_argument("docx")
    a.add_argument("--json", action="store_true")
    b = sub.add_parser("aplicar", help="aplica operações de um JSON e grava o redline")
    b.add_argument("docx")
    b.add_argument("ops_json")
    b.add_argument("saida")
    b.add_argument("--autor", required=True)
    b.add_argument("--data", default=None, help="ISO UTC, ex. 2026-09-08T12:00:00Z")
    c = sub.add_parser("verificar", help="rejeitar tudo no redline == original?")
    c.add_argument("original")
    c.add_argument("redline")
    d = sub.add_parser("texto", help="texto por parágrafo")
    d.add_argument("docx")
    d.add_argument("--modo", choices=["vivo", "aceito", "rejeitado"], default="vivo")
    args = ap.parse_args(argv)

    if args.cmd == "radiografia":
        r = radiografia(args.docx)
        if args.json:
            print(json.dumps(r, ensure_ascii=False, indent=1))
            return 0
        print(f"partes: {len(r['partes'])} | fonte padrão: {r['fonte_padrao']} | página: {r['pagina_twips']}")
        print("marcas por autor:", r["marcas_por_autor"] or "nenhuma")
        print(f"comentários: {len(r['comentarios'])}")
        for cm in r["comentarios"]:
            print(f"   [{cm['autor']}] {cm['texto']}")
        print(f"placeholders: {len(r['placeholders'])}")
        for ph in r["placeholders"]:
            print(f"   #{ph['i']} {ph['placeholder']!r} | {ph['contexto']}")
        print("parágrafos:")
        for p in r["paragrafos"]:
            if p.get("tabela"):
                print(f"   #{p['i']} [TABELA]")
            else:
                num = f" num{p['numPr']}" if p["numPr"] else ""
                marca = " *marcas*" if p["marcas_terceiro"] else ""
                print(f"   #{p['i']}{num}{marca} {p['texto'][:110]}")
        return 0
    if args.cmd == "aplicar":
        ops = json.loads(Path(args.ops_json).read_text(encoding="utf-8"))
        r = Redline(args.docx, autor=args.autor, data=args.data)
        for n, o in enumerate(ops, 1):
            try:
                _OPS[o["op"]](r, o)
            except Exception as e:  # noqa: BLE001
                print(f"FALHA na operação {n} ({o.get('op')}): {e}", file=sys.stderr)
                return 2
            print(f"ok {n:3d} {o['op']:15s} {str(o.get('onde') or o.get('modelo'))[:60]}")
        r.salvar(args.saida)
        est = r.estatisticas()
        div = verificar(args.docx, args.saida)
        print(f"gravado {args.saida} | ins={est['ins']} del={est['del']} autores={est['autores']} | divergencias={len(div)}")
        return 0 if not div else 3
    if args.cmd == "verificar":
        div = verificar(args.original, args.redline)
        for dv in div:
            print(f"- #{dv['indice_original']}\n  original : {dv['original']!r}\n  rejeitado: {dv['rejeitado']!r}")
        print("OK: rejeitar tudo devolve o original" if not div else f"{len(div)} divergência(s)")
        return 0 if not div else 3
    if args.cmd == "texto":
        for i, t in enumerate(_textos(args.docx, args.modo)):
            print(f"#{i} {'[TABELA]' if t is None else t}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(_cli())
