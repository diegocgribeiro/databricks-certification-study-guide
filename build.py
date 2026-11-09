#!/usr/bin/env python3
"""Gera os dados do site de estudos multi-certificação (study-site/data/).

Entradas (todas já existem no repositório):
  - practice/data/*.json                       -> questões (inglês) de todas as certificações
  - certifications/<cert>/**.md                -> aulas em inglês
  - <cert>-ptbr/pt-br/certifications/<cert>/   -> aulas em PT-BR (usadas no lugar do inglês quando existem)

Saídas:
  - study-site/data/catalog.js   -> lista de certificações (carregada sempre, é pequena)
  - study-site/data/<cert>.js    -> questões + aulas de uma certificação (carregado sob demanda)

Uso:  python study-site/build.py      (somente biblioteca padrão)
"""
from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from pathlib import Path

_here = Path(__file__).resolve().parent
_root = _here.parent
# No Windows, o prefixo \\?\ evita o limite de 260 caracteres em caminhos longos
LONG = os.name == "nt" and not str(_root).startswith("\\\\")
ROOT = Path("\\\\?\\" + str(_root)) if LONG else _root
SITE = ROOT / "study-site"
OUT = SITE / "data"

CERTS = [
    # id, título PT, nível, minutos do simulado, cor
    ("data-engineer-associate", "Data Engineer Associate", "Associate", 90, "#4f46e5"),
    ("data-engineer-professional", "Data Engineer Professional", "Professional", 120, "#7c3aed"),
    ("data-analyst-associate", "Data Analyst Associate", "Associate", 90, "#0891b2"),
    ("ml-associate", "Machine Learning Associate", "Associate", 90, "#16a34a"),
    ("ml-professional", "Machine Learning Professional", "Professional", 120, "#ca8a04"),
    ("genai-engineer-associate", "Generative AI Engineer Associate", "Associate", 90, "#db2777"),
]

STOP = set("""the a an and or of to in on for with is are be by as at from that this it its into which what when
how can should using use used not no yes will would their there they them than then these those such each any all
your you our out over more most only also may must have has had been being does done data table tables databricks
question answer correct option options following best engineer team need needs want wants new run runs""".split())


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def strip_frontmatter(text: str) -> tuple[dict, str]:
    meta = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                m = re.match(r"^(\w+):\s*(.+)$", line.strip())
                if m:
                    meta[m.group(1)] = m.group(2).strip().strip('"')
            text = text[end + 4:].lstrip("\n")
    return meta, text


def first_h1(md: str) -> str:
    m = re.search(r"^#\s+(.+)$", md, re.M)
    return re.sub(r"[*`]", "", m.group(1)).strip() if m else ""


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT)).replace("\\", "/")


def lesson_root(cert: str) -> tuple[Path, str]:
    pt = ROOT / f"{cert}-ptbr" / "pt-br" / "certifications" / cert
    if pt.is_dir():
        return pt, "pt"
    return ROOT / "certifications" / cert, "en"


def build_lessons(cert: str) -> tuple[list[dict], str, str]:
    root, lang = lesson_root(cert)
    lessons = []
    files = []
    for p in sorted(root.rglob("*.md")):
        r = str(p.relative_to(root)).replace("\\", "/")
        parts = r.split("/")
        # questões ficam no banco do quiz, não como aulas
        if any(x in ("practice-questions", "mock-exam", "mock-exam-2", "questoes") for x in parts):
            continue
        if parts[0] in ("resources", "recursos") and len(parts) > 2:
            continue
        if r.lower().startswith(("status", "glossary")):
            continue
        files.append((r, p))
    for r, p in files:
        meta, body = strip_frontmatter(read(p))
        lid = r[:-3]
        parts = lid.split("/")
        if lid == "README":
            group, folder, order = "geral", "", 0
        elif parts[0] in ("resources", "recursos"):
            group, folder, order = "recursos", parts[0], 0
        elif re.match(r"^\d\d-", parts[0]):
            group, folder = "modulo", parts[0]
            order = 0 if parts[-1] == "README" else (int(m.group(1)) if (m := re.match(r"^(\d+)", parts[-1])) else 50)
        else:
            group, folder, order = "outros", parts[0], 0
        lessons.append({"id": lid, "folder": folder, "group": group, "order": order,
                        "isIndex": parts[-1] == "README" and group == "modulo",
                        "title": meta.get("title") or first_h1(body) or parts[-1], "md": body})
    return lessons, lang, rel(root)


def tokens(text: str) -> list[str]:
    text = re.sub(r"https?://\S+", " ", text.lower())
    return [t for t in re.findall(r"[a-z_][a-z0-9_.]{2,}", text) if t not in STOP and not t.isdigit()]


class Mapper:
    """Liga cada questão à aula mais parecida (TF-IDF simples sobre o texto das aulas)."""

    def __init__(self, lessons: list[dict]):
        self.docs = [l for l in lessons if l["group"] == "modulo" and not l["isIndex"]]
        df = Counter()
        self.tf = []
        for l in self.docs:
            # título e cabeçalhos pesam mais
            heads = " ".join(re.findall(r"^#{1,4}\s+(.+)$", l["md"], re.M))
            c = Counter(tokens(l["md"])) + Counter(tokens((l["title"] + " " + heads) * 4))
            self.tf.append(c)
            df.update(set(c))
        n = max(1, len(self.docs))
        self.idf = {t: math.log(1 + n / d) for t, d in df.items()}

    def best(self, text: str) -> str | None:
        q = Counter(tokens(text))
        best, best_s = None, 0.0
        for l, tf in zip(self.docs, self.tf):
            tot = sum(tf.values()) or 1
            s = sum(min(cnt, 3) * self.idf.get(t, 0) * math.sqrt(tf[t] / tot) for t, cnt in q.items() if t in tf)
            if s > best_s:
                best, best_s = l["id"], s
        return best


def load_dea_config():
    p = SITE / "dea-config.json"
    return json.loads(read(p)) if p.exists() else None


def dea_map(q: dict, cfg: dict, lesson_ids: set) -> tuple[str | None, str | None]:
    folder_of = {d["id"]: d["folder"] for d in cfg["domains"]}
    text = " ".join([q.get("title", ""), q.get("question", ""), " ".join(q.get("choices", {}).values()),
                     q.get("shortAnswer", ""), q.get("explanation", "")]).lower()

    def score(lid):
        return sum(w * min(text.count(k.lower()), 3) for k, w in cfg["keywords"].get(lid, {}).items())

    folder = folder_of.get(q["domain"])
    own = [k for k in cfg["keywords"] if folder and k.startswith(folder + "/") and k in lesson_ids]
    best, bs = None, 0
    for lid in own:
        s = score(lid)
        if s > bs:
            best, bs = lid, s
    alt, als = None, 0
    for lid in cfg["keywords"]:
        if lid in own or lid not in lesson_ids:
            continue
        s = score(lid)
        if s > als:
            alt, als = lid, s
    if best is None and folder and f"{folder}/README" in lesson_ids:
        best = f"{folder}/README"
    related = alt if alt and als >= max(6, bs + 3) else None
    return best, related


def clean_domain_name(name: str) -> str:
    name = re.sub(r"^Practice Questions\s*[:\-—–]\s*", "", name.strip())
    return re.sub(r"^Domain\s+\d+\s*[:\-—–]\s*", "", name).strip()


def question_title(q: dict, n: int) -> str:
    t = (q.get("title") or "").strip()
    if not t or re.fullmatch(r"Question \d+", t):
        plain = re.sub(r"```.*?```", " ", q["question"], flags=re.S)
        plain = re.sub(r"\s+", " ", re.sub(r"[`*]", "", plain)).strip()
        t = plain if len(plain) <= 90 else plain[:87].rsplit(" ", 1)[0] + "…"
    return t


def build_cert(cert, title, level, minutes, color, dea_cfg):
    data_dir = ROOT / "practice" / "data"
    lessons, lang, lroot = build_lessons(cert)
    lesson_ids = {l["id"] for l in lessons}
    mapper = Mapper(lessons)
    use_dea = cert == "data-engineer-associate" and dea_cfg and lang == "pt"

    banks, questions, domains = [], [], {}
    spec = [("praticas", f"{cert}.json", "Questões práticas", "practice"),
            ("simulado-1", f"{cert}-mock-1.json", "Simulado 1", "mock"),
            ("simulado-2", f"{cert}-mock-2.json", "Simulado 2", "mock")]
    seen = set()
    for bank_id, fname, label, kind in spec:
        f = data_dir / fname
        if not f.exists():
            continue
        try:
            data = json.loads(read(f))
        except Exception as e:  # um arquivo ruim não derruba o site inteiro
            print(f"  ! ignorando {fname}: {e}")
            continue
        for d in data.get("domains", []):
            domains.setdefault(d["id"], {"id": d["id"], "name": clean_domain_name(d.get("name", d["id"])), "count": 0, "fromMock": kind == "mock"})
        n_ok = 0
        for n, q in enumerate(data.get("questions", []), 1):
            ch = q.get("choices") or {}
            if not q.get("id") or q["id"] in seen or len(ch) < 2 or q.get("correctAnswer") not in ch:
                print(f"  ! questão inválida ignorada: {q.get('id')}")
                continue
            seen.add(q["id"])
            dom = q.get("domain") or "geral"
            domains.setdefault(dom, {"id": dom, "name": dom.replace("-", " ").title(), "count": 0, "fromMock": kind == "mock"})
            domains[dom]["count"] += 1
            if use_dea:
                lesson, related = dea_map(q, dea_cfg, lesson_ids)
            else:
                lesson = mapper.best(" ".join([q.get("title", ""), q["question"], " ".join(ch.values()),
                                               q.get("shortAnswer", ""), q.get("explanation", "")]))
                related = None
            questions.append({
                "id": q["id"], "bank": bank_id, "n": n, "domain": dom, "title": question_title(q, n),
                "difficulty": q.get("difficulty", "medium"), "question": q["question"], "choices": ch,
                "answer": q["correctAnswer"], "short": q.get("shortAnswer", ""), "explanation": q.get("explanation", ""),
                "lesson": lesson, "related": related,
            })
            n_ok += 1
        banks.append({"id": bank_id, "label": label, "kind": kind, "count": n_ok})

    # pesos: oficiais no DE Associate; nos demais, proporção de questões
    total = sum(d["count"] for d in domains.values()) or 1
    dom_list = []
    official = {d["id"]: d for d in dea_cfg["domains"]} if (cert == "data-engineer-associate" and dea_cfg) else {}
    for i, d in enumerate(sorted(domains.values(), key=lambda x: (x["fromMock"], 0))):
        if d["count"] == 0:
            continue
        o = official.get(d["id"])
        dom_list.append({"id": d["id"], "name": o["namePt"] if o else d["name"], "nameEn": d["name"],
                         "weight": o["weight"] if o else round(100 * d["count"] / total, 1),
                         "official": bool(o), "count": d["count"]})
    mock = next((b for b in banks if b["kind"] == "mock"), None)
    exam_size = mock["count"] if mock else 45
    meta = {"id": cert, "title": title, "level": level, "color": color, "examMinutes": minutes, "examSize": exam_size,
            "lang": lang, "lessonRoot": lroot, "questionCount": len(questions),
            "lessonCount": sum(1 for l in lessons if l["group"] == "modulo" and not l["isIndex"]),
            "banks": banks, "domains": dom_list, "officialWeights": bool(official)}
    payload = {"meta": meta, "questions": questions, "lessons": lessons}
    return meta, payload


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    dea_cfg = load_dea_config()
    catalog = []
    for spec in CERTS:
        meta, payload = build_cert(*spec, dea_cfg)
        if not payload["questions"]:
            print(f"  ! {spec[0]} sem questões, pulando")
            continue
        js = ("// Gerado por study-site/build.py — não edite à mão\n"
              "(window.CERTDATA = window.CERTDATA || {})[" + json.dumps(spec[0]) + "] = "
              + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
        (OUT / f"{spec[0]}.js").write_text(js, encoding="utf-8")
        catalog.append(meta)
        print(f"{spec[0]:28s} {meta['questionCount']:4d} questões · {meta['lessonCount']:3d} aulas ({meta['lang']})")
    version = str(abs(hash(json.dumps(catalog, sort_keys=True))) % 10**10)
    (OUT / "catalog.js").write_text(
        "// Gerado por study-site/build.py — não edite à mão\nwindow.CATALOG = "
        + json.dumps({"version": version, "certs": catalog}, ensure_ascii=False) + ";\n", encoding="utf-8")


if __name__ == "__main__":
    main()
