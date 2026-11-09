"""Compile one raw source into wiki articles with Gemini.

The article schema is the one in karpathy-llm-wiki. Numbers, dates, and
quotations have to appear in the raw file; check_evidence.py rejects a
compile that breaks that rule, and the previous wiki pages are restored.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from qss.corpus import article_meta

BEIRUT = ZoneInfo("Asia/Beirut")
ARTICLE_PATH_RE = re.compile(r"^wiki/(?!index\.md$|log\.md$)([^/]+)/([^/]+\.md)$")
DISPOSITIONS = {"New", "Update", "Disputed", "No material"}


def today() -> str:
    return datetime.now(BEIRUT).date().isoformat()


def compile_source(root: Path, raw_rel: str, collected: str) -> dict:
    """Return a result dict. Writes wiki files only when evidence checks pass."""
    raw_path = root / raw_rel
    raw_text = raw_path.read_text(encoding="utf-8")
    from qss.gemini import GeminiError, api_key, generate

    if not api_key():
        _append_log(
            root,
            f"## [{collected}] ingest | compile skipped: {raw_rel}\n"
            "- Disposition: fetched, not compiled\n"
            f"- Raw: {raw_rel}\n"
            "- Note: GEMINI_API_KEY was not available, so no wiki page was written. "
            "The source is still searchable on the site.",
        )
        return {"ok": True, "compiled": False, "reason": "no api key"}

    system = _system_prompt(collected)
    user = _user_prompt(root, raw_rel, raw_text)
    try:
        text, finish = generate(system, user, max_output_tokens=8192, thinking_budget=1024)
    except GeminiError as exc:
        _fail_log(root, collected, raw_rel, f"Gemini compile failed: {exc}")
        return {"ok": False, "compiled": False, "reason": str(exc)}
    if finish == "MAX_TOKENS":
        _fail_log(root, collected, raw_rel, "Gemini compile was cut off before the article was complete.")
        return {"ok": False, "compiled": False, "reason": "truncated"}

    try:
        payload = parse_compile_payload(text)
    except ValueError as exc:
        _fail_log(root, collected, raw_rel, f"Gemini compile returned unreadable JSON ({exc}).")
        return {"ok": False, "compiled": False, "reason": "bad json"}

    disposition = _disposition(payload.get("disposition", ""))
    articles = payload.get("articles") or []
    if disposition == "No material" or not articles:
        _append_log(
            root,
            f"## [{collected}] ingest | no material: {raw_rel}\n- Disposition: No material",
        )
        return {"ok": True, "compiled": False, "reason": "no material"}

    prepared = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        path = safe_article_path(str(article.get("path", "")))
        content = article.get("content")
        if not path or not isinstance(content, str):
            continue
        content = ensure_article_header(content.strip() + "\n", raw_rel, collected)
        summary = re.sub(r"\s+", " ", str(article.get("summary") or "")).strip()[:180]
        prepared.append({"path": path, "content": content, "summary": summary})
    if not prepared:
        _fail_log(root, collected, raw_rel, "Gemini compile did not return a valid wiki path.")
        return {"ok": False, "compiled": False, "reason": "no valid articles"}

    support = min(content_word_support(item["content"], raw_text) for item in prepared)
    if support < 0.5:
        _fail_log(
            root,
            collected,
            raw_rel,
            "Compile was rejected because too much of the draft was not in the source text.",
        )
        return {"ok": False, "compiled": False, "reason": "ungrounded", "support": support}

    targets = [root / item["path"] for item in prepared]
    snap = _snapshot([root / "wiki" / "index.md", root / "wiki" / "log.md", *targets])
    for item in prepared:
        dest = root / item["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(item["content"], encoding="utf-8")
    summaries = {item["path"]: item["summary"] for item in prepared if item["summary"]}
    rebuild_index(root, summaries)

    suspects, errors, report = evidence_for(root, [item["path"] for item in prepared])
    if errors or suspects:
        _restore(snap)
        detail = report.strip().splitlines()
        tail = " ".join(detail[-8:])[:500]
        _fail_log(
            root,
            collected,
            raw_rel,
            "Compile was rejected because a fact in the draft article was not found verbatim in the source. "
            + tail,
        )
        return {"ok": False, "compiled": False, "reason": "evidence", "report": report}

    primary = re.sub(r"\s+", " ", str(payload.get("primary_title") or "")).strip()
    if not primary:
        primary = article_meta(prepared[0]["content"])["title"] or prepared[0]["path"]
    cascade = payload.get("cascade_titles") or []
    lines = [
        f"## [{collected}] ingest | {primary}",
        f"- Disposition: {disposition}",
        f"- Raw: {raw_rel}",
    ]
    if isinstance(cascade, list):
        for title in cascade:
            cleaned = re.sub(r"\s+", " ", str(title)).strip()
            if cleaned:
                lines.append(f"- Updated: {cleaned}")
    _append_log(root, "\n".join(lines))
    return {"ok": True, "compiled": True, "articles": [item["path"] for item in prepared]}


def parse_compile_payload(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("no JSON object") from None
        payload = json.loads(cleaned[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("compile result was not an object")
    return payload


def safe_article_path(path: str) -> str | None:
    path = path.strip().replace("\\", "/")
    if path.startswith("./"):
        path = path[2:]
    if ".." in path.split("/"):
        return None
    match = ARTICLE_PATH_RE.match(path)
    if not match:
        return None
    topic, filename = match.group(1), match.group(2)
    if topic.startswith(".") or filename.startswith("."):
        return None
    if not re.fullmatch(r"[\w.-]+", topic, flags=re.UNICODE):
        return None
    if not re.fullmatch(r"[\w.-]+\.md", filename, flags=re.UNICODE):
        return None
    return path


def ensure_article_header(content: str, raw_rel: str, collected: str) -> str:
    lines = content.splitlines()
    title = "Untitled"
    body_start = 0
    for index, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip() or title
            body_start = index + 1
            break
    header = []
    index = body_start
    while index < len(lines) and (not lines[index].strip() or lines[index].strip().startswith(">")):
        if lines[index].strip().startswith(">"):
            header.append(lines[index].strip())
        index += 1
    body = "\n".join(lines[index:]).strip()
    raw_link = _raw_link(raw_rel)
    label = Path(raw_rel).name
    kept = []
    raw_lines = []
    has_sources = False
    has_updated = False
    for line in header:
        if re.match(r"^>\s*Raw:", line):
            raw_lines.append(line)
            continue
        if re.match(r"^>\s*Sources?:", line):
            has_sources = True
        if re.match(r"^>\s*Updated:", line):
            has_updated = True
        kept.append(line)
    if not has_sources:
        kept.insert(0, f"> Sources: uploaded document, {collected}")
    raw_line = f"> Raw: [{label}]({raw_link})"
    if not raw_lines:
        raw_lines = [raw_line]
    elif raw_link not in "\n".join(raw_lines):
        raw_lines[0] = raw_lines[0].rstrip() + f"; [{label}]({raw_link})"
    inserted = False
    rebuilt = []
    for line in kept:
        rebuilt.append(line)
        if not inserted and re.match(r"^>\s*Sources?:", line):
            rebuilt.extend(raw_lines)
            inserted = True
    if not inserted:
        rebuilt = raw_lines + rebuilt
    if not has_updated:
        rebuilt.append(f"> Updated: {collected}")
    return f"# {title}\n\n" + "\n".join(rebuilt) + "\n\n" + body + "\n"


def content_word_support(article: str, raw_text: str) -> float:
    """Share of the article's longer words that also appear in the raw body.

    The evidence script checks numbers, dates, and quotations. This catches a
    fluent paragraph that invents a rule without using any of those.
    """
    raw_words = set(_content_words(article_meta(raw_text)["body"]))
    words = _content_words(article_meta(article)["body"])
    if not words:
        return 1.0
    return sum(1 for word in words if word in raw_words) / len(words)


def _content_words(text: str) -> list[str]:
    kept = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if re.match(r"^>\s*\*\*Status:", stripped):
            continue
        kept.append(stripped)
    return re.findall(r"[\w]{5,}", " ".join(kept).lower(), flags=re.UNICODE)


def _raw_link(raw_rel: str) -> str:
    # wiki/<topic>/article.md -> ../../raw/<topic>/file.md
    return "../../" + raw_rel


def rebuild_index(root: Path, fresh_summaries: dict[str, str]) -> None:
    index_path = root / "wiki" / "index.md"
    previous = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
    old_summaries, blurbs = _parse_index(previous)
    grouped: dict[str, list[dict]] = {}
    wiki = root / "wiki"
    for path in sorted(wiki.rglob("*.md")):
        rel_in_wiki = path.relative_to(wiki).as_posix()
        if rel_in_wiki in {"index.md", "log.md"} or path.name.lower() == "readme.md":
            continue
        if len(path.relative_to(wiki).parts) != 2:
            continue
        text = path.read_text(encoding="utf-8")
        meta = article_meta(text)
        if not meta["title"]:
            continue
        project_rel = path.relative_to(root).as_posix()
        summary = fresh_summaries.get(project_rel) or old_summaries.get(rel_in_wiki) or meta["summary"] or "(no summary)"
        if meta["archived"] and not summary.startswith("[Archived]"):
            summary = "[Archived] " + summary
        grouped.setdefault(path.parent.name, []).append(
            {
                "title": meta["title"],
                "link": rel_in_wiki,
                "summary": summary.replace("|", "/"),
                "updated": meta["updated"] or today(),
            }
        )
    lines = ["# Knowledge Base Index", ""]
    for topic in sorted(grouped):
        lines.append(f"## {topic}")
        lines.append("")
        lines.append(blurbs.get(topic) or "Documents filed under this topic.")
        lines.append("")
        lines.append("| Article | Summary | Updated |")
        lines.append("|---------|---------|---------|")
        for row in sorted(grouped[topic], key=lambda item: item["title"].lower()):
            lines.append(f"| [{row['title']}]({row['link']}) | {row['summary']} | {row['updated']} |")
        lines.append("")
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _parse_index(text: str) -> tuple[dict[str, str], dict[str, str]]:
    summaries = {}
    blurbs = {}
    topic = ""
    for line in text.splitlines():
        heading = re.match(r"^##\s+(.+)$", line.strip())
        if heading:
            topic = heading.group(1).strip()
            continue
        if topic and line.strip() and not line.strip().startswith("|") and topic not in blurbs:
            blurbs[topic] = line.strip()
        row = re.match(r"^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*([^|]+)\|", line.strip())
        if row and topic:
            summaries[row.group(2).strip()] = row.group(3).strip()
    return summaries, blurbs


def evidence_for(root: Path, article_paths: list[str]) -> tuple[int, int, str]:
    script = root / ".agents" / "skills" / "karpathy-llm-wiki" / "scripts" / "check_evidence.py"
    if not script.is_file():
        return 0, 1, "check_evidence.py is missing"
    result = subprocess.run(
        [sys.executable, str(script), str(root), *article_paths],
        capture_output=True,
        text=True,
        check=False,
    )
    report = (result.stdout or "") + (result.stderr or "")
    match = re.search(
        r"(\d+) fidelity suspect\(s\), (\d+) evidence error\(s\), (\d+) unreferenced raw file\(s\)",
        report,
    )
    if not match:
        return 0, 1, report[-1000:]
    return int(match.group(1)), int(match.group(2)), report


def _system_prompt(collected: str) -> str:
    return f"""You compile one source into a markdown wiki for the QSS Parent Committee.

Rules:
- Use only facts that appear in the source body. Do not add rules, dates, names, counts, or events from anywhere else.
- Every number, date, and quoted phrase in an article, including the title, must appear verbatim in the source body. The Collected date is not part of the source body.
- Do not put quotation marks around words unless you copy them exactly from the source.
- Do not write today's date in the title or body. The Updated metadata line is {collected} and is the only place that date belongs, unless the source body itself contains it.
- Distill and organize. Do not paste the whole source.
- If the source adds nothing beyond the articles you were given, return disposition "No material" and an empty articles array.
- If it contradicts an existing article, keep both claims and put this block under the contested claim:
> **Status: Disputed**
> The two claims, each attributed to its source.
- Use one topic directory only: wiki/<topic>/<article>.md
- Filename and topic: lowercase kebab-case, named after the concept.
- Reuse an existing topic when it fits. Merge into an existing article when the subject is the same, and include the full updated article.
- From wiki/<topic>/<article>.md, the Raw link for this source is a relative path given in the user message. Include it.
- Article shape:
# Title

> Sources: document name, date if the source states one
> Raw: [filename](relative raw path)
> Updated: {collected}

## Overview

One paragraph.

## More sections only when the source supports them

- At most 4 articles. Each article under 700 words.
- Write in the language of the source. Keep both languages when the source is bilingual.
- Return one JSON object and nothing else:
{{"disposition":"New","primary_title":"...","cascade_titles":[],"articles":[{{"path":"wiki/topic/article.md","summary":"one line","content":"full markdown"}}]}}
- disposition is one of: New, Update, Disputed, No material.
"""


def _user_prompt(root: Path, raw_rel: str, raw_text: str) -> str:
    index_path = root / "wiki" / "index.md"
    index = index_path.read_text(encoding="utf-8") if index_path.exists() else "# Knowledge Base Index\n"
    related = _related_articles(root, raw_text)
    clipped = raw_text[:80000]
    link = _raw_link(raw_rel)
    return (
        f"New source path: {raw_rel}\n"
        f"Raw link to write in each article that uses it: [{Path(raw_rel).name}]({link})\n\n"
        f"Current index:\n{index[:12000]}\n\n"
        f"Existing articles that share words with this source:\n{related}\n\n"
        f"Source file:\n{clipped}"
    )


def _related_articles(root: Path, raw_text: str, limit: int = 4) -> str:
    tokens = set(re.findall(r"[\w]{4,}", raw_text.lower(), flags=re.UNICODE))
    wiki = root / "wiki"
    scored = []
    if wiki.is_dir():
        for path in wiki.rglob("*.md"):
            rel = path.relative_to(wiki).as_posix()
            if rel in {"index.md", "log.md"} or len(path.relative_to(wiki).parts) != 2:
                continue
            text = path.read_text(encoding="utf-8")
            words = set(re.findall(r"[\w]{4,}", text.lower(), flags=re.UNICODE))
            score = len(tokens & words)
            if score:
                scored.append((score, path.relative_to(root).as_posix(), text[:5000]))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored:
        return "(none)"
    blocks = [f"--- {path}\n{text}" for _, path, text in scored[:limit]]
    return "\n\n".join(blocks)


def _disposition(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", str(value)).strip()
    if cleaned in DISPOSITIONS:
        return cleaned
    for allowed in DISPOSITIONS:
        if allowed.lower() in cleaned.lower():
            return allowed
    return "Update"


def _fail_log(root: Path, collected: str, raw_rel: str, note: str) -> None:
    note = re.sub(r"\s+", " ", note).strip()[:700]
    _append_log(
        root,
        f"## [{collected}] ingest | compile failed: {raw_rel}\n"
        "- Disposition: fetched, compile rejected\n"
        f"- Raw: {raw_rel}\n"
        f"- Note: {note}",
    )


def _append_log(root: Path, entry: str) -> None:
    log_path = root / "wiki" / "log.md"
    text = log_path.read_text(encoding="utf-8") if log_path.exists() else "# Wiki Log\n"
    if not text.endswith("\n"):
        text += "\n"
    if not text.endswith("\n\n"):
        text += "\n"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(text + entry.strip() + "\n", encoding="utf-8")


def _snapshot(paths: list[Path]) -> dict[Path, bytes | None]:
    snap = {}
    for path in paths:
        snap[path] = path.read_bytes() if path.exists() else None
    return snap


def _restore(snap: dict[Path, bytes | None]) -> None:
    for path, data in snap.items():
        if data is None:
            if path.exists():
                path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
