"""Build the search corpus published with the static site."""

from __future__ import annotations

import re
from pathlib import Path

SKIP_FILES = {"index.md", "log.md", "readme.md"}
CHUNK_SIZE = 900


def build_corpus(root: Path) -> dict:
    articles = []
    chunks = []
    for kind, folder in (("wiki", root / "wiki"), ("raw", root / "raw")):
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*.md")):
            rel = path.relative_to(root).as_posix()
            if path.name.lower() in SKIP_FILES:
                continue
            if any(part.startswith(".") or part.startswith("_") for part in path.relative_to(folder).parts):
                continue
            text = path.read_text(encoding="utf-8")
            meta = article_meta(text)
            if not meta["title"]:
                continue
            record = {
                "path": rel,
                "title": meta["title"],
                "topic": path.parent.name if path.parent != folder else kind,
                "summary": meta["summary"],
                "updated": meta["updated"],
                "kind": kind,
                "source": meta["source"],
            }
            articles.append(record)
            chunks.extend(chunk_article(record, meta["body"]))
    articles.sort(key=lambda item: (item["kind"] != "wiki", item["topic"], item["title"].lower()))
    return {"articles": articles, "chunks": chunks}


def article_meta(text: str) -> dict:
    title = ""
    updated = ""
    archived = ""
    source = ""
    lines = text.splitlines()
    for line in lines:
        if not title and line.startswith("# "):
            title = line[2:].strip()
        stripped = line.strip()
        updated_match = re.match(r"^>\s*Updated:\s*(\d{4}-\d{2}-\d{2})", stripped)
        if updated_match:
            updated = updated_match.group(1)
        archived_match = re.match(r"^>\s*Archived:\s*(\d{4}-\d{2}-\d{2})", stripped)
        if archived_match:
            archived = archived_match.group(1)
        source_match = re.match(r"^>\s*Source:\s*(.+)", stripped)
        if source_match:
            source = source_match.group(1).strip()
    body = _body(text)
    summary = _overview_sentence(body) or _first_sentence(body)
    return {
        "title": title,
        "updated": archived or updated,
        "archived": bool(archived),
        "source": source,
        "summary": summary[:180],
        "body": body,
    }


def _body(text: str) -> str:
    lines = text.splitlines()
    start = 0
    seen_title = False
    for index, line in enumerate(lines):
        if not seen_title and line.startswith("# "):
            seen_title = True
            start = index + 1
            continue
        if seen_title and line.strip().startswith(">"):
            start = index + 1
            continue
        if seen_title and not line.strip():
            start = index + 1
            continue
        if seen_title:
            break
    return "\n".join(lines[start:]).strip()


def _overview_sentence(body: str) -> str:
    capture = False
    buf: list[str] = []
    for line in body.splitlines():
        if line.startswith("## "):
            if capture:
                break
            capture = line[3:].strip().lower() == "overview"
            continue
        if not capture:
            continue
        if line.startswith("#") or line.startswith(">"):
            continue
        if not line.strip():
            if buf:
                break
            continue
        buf.append(line.strip())
    return _first_sentence(" ".join(buf))


def _first_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s", text, maxsplit=1)
    return parts[0]


def chunk_article(record: dict, body: str) -> list[dict]:
    sections = _sections(body)
    chunks = []
    for heading, text in sections:
        for piece in _pack(text, CHUNK_SIZE):
            if len(piece) < 40 and chunks:
                continue
            chunks.append(
                {
                    "id": f"{record['path']}#{len(chunks)}",
                    "path": record["path"],
                    "title": record["title"],
                    "heading": heading,
                    "text": piece,
                    "kind": record["kind"],
                    "topic": record["topic"],
                    "updated": record["updated"],
                }
            )
    return chunks


def _sections(body: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    heading = "Overview"
    buf: list[str] = []
    for line in body.splitlines():
        if line.startswith("## ") or line.startswith("### "):
            if buf:
                sections.append((heading, buf))
            heading = line.lstrip("#").strip() or "Overview"
            buf = []
            continue
        buf.append(line)
    if buf:
        sections.append((heading, buf))
    if not sections:
        return []
    return [(heading, "\n".join(lines).strip()) for heading, lines in sections if "\n".join(lines).strip()]


def _pack(text: str, size: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    parts = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            cut = text.rfind("\n", start, end)
            if cut < start + 200:
                cut = text.rfind(" ", start, end)
            if cut > start + 200:
                end = cut
        piece = text[start:end].strip()
        if piece:
            parts.append(piece)
        if end <= start:
            break
        start = end
    return parts
