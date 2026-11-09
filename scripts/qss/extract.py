"""Turn an uploaded file into immutable raw markdown."""

from __future__ import annotations

import re
import shutil
import subprocess
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

TEXT_EXT = {".md", ".markdown", ".txt", ".csv"}
HTML_EXT = {".html", ".htm"}
DOCX_EXT = {".docx"}
PDF_EXT = {".pdf"}
SUPPORTED = TEXT_EXT | HTML_EXT | DOCX_EXT | PDF_EXT
SKIP_NAMES = {"readme.md", ".gitkeep"}
RESERVED_TOPICS = {"index", "log", "processed", "sources", "wiki", "raw", "inbox"}


def is_inbox_document(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name.startswith(".") or path.name.startswith("_"):
        return False
    if path.name.lower() in SKIP_NAMES:
        return False
    return path.suffix.lower() in SUPPORTED


def slugify(name: str, limit: int = 60) -> str:
    stem = Path(name).stem.lower().strip()
    stem = re.sub(r"[^\w]+", "-", stem, flags=re.UNICODE)
    stem = stem.strip("-_")
    if not stem:
        stem = "document"
    return stem[:limit].strip("-_") or "document"


def topic_for(inbox_root: Path, path: Path) -> str:
    rel = path.relative_to(inbox_root)
    if len(rel.parts) >= 2:
        topic = slugify(rel.parts[0], 40)
    else:
        topic = "committee"
    if topic in RESERVED_TOPICS:
        return "committee"
    return topic


def iter_inbox(inbox_root: Path) -> list[Path]:
    if not inbox_root.is_dir():
        return []
    found = []
    for path in sorted(inbox_root.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(inbox_root).parts
        if any(part.startswith(".") or part.startswith("_") for part in rel_parts):
            continue
        if is_inbox_document(path):
            found.append(path)
    return found


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in TEXT_EXT:
        return _read_text(path)
    if ext in HTML_EXT:
        return _html_to_text(path.read_bytes())
    if ext in DOCX_EXT:
        return _docx_to_text(path)
    if ext in PDF_EXT:
        return _pdf_to_text(path)
    raise ValueError(f"unsupported file type: {path.name}")


def _read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1256", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


class _HTMLText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self._skip += 1
        if tag in {"p", "div", "br", "h1", "h2", "h3", "h4", "li", "tr", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1
        if tag in {"p", "div", "li", "h1", "h2", "h3", "h4", "tr"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def _html_to_text(data: bytes) -> str:
    parser = _HTMLText()
    parser.feed(data.decode("utf-8", errors="replace"))
    raw = "".join(parser.parts)
    raw = re.sub(r"[ \t]+\n", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_to_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError(f"could not read Word file {path.name}") from exc
    root = ET.fromstring(xml)
    paragraphs = []
    for para in root.iter(W_NS + "p"):
        line = "".join(node.text or "" for node in para.iter(W_NS + "t")).strip()
        if line:
            paragraphs.append(line)
    text = "\n\n".join(paragraphs).strip()
    if not text:
        raise ValueError(f"Word file {path.name} has no text")
    return text


def _pdf_to_text(path: Path) -> str:
    errors = []
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        pages = [(page.extract_text() or "") for page in reader.pages]
        text = "\n\n".join(pages).strip()
        if text:
            return text
        errors.append("pypdf extracted no text")
    except Exception as exc:  # try the next extractor
        errors.append(f"pypdf: {exc}")

    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        try:
            result = subprocess.run(
                [pdftotext, "-layout", "-enc", "UTF-8", str(path), "-"],
                check=True,
                capture_output=True,
                text=True,
            )
            if result.stdout.strip():
                return result.stdout.strip()
            errors.append("pdftotext extracted no text")
        except subprocess.CalledProcessError as exc:
            errors.append(f"pdftotext: {(exc.stderr or '')[:200]}")
    raise ValueError(
        f"could not extract text from {path.name}. "
        "If this is a scanned PDF, export a text-based PDF or paste the text into a .md file. "
        + "; ".join(errors)
    )


def guess_title(text: str, filename: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            if title:
                return title[:120]
    stem = Path(filename).stem.replace("_", " ").replace("-", " ")
    stem = re.sub(r"\s+", " ", stem).strip()
    return (stem or "Document")[:120]


def raw_document(title: str, source: str, collected: str, published: str, body: str) -> str:
    cleaned = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return (
        f"# {title}\n\n"
        f"> Source: {source}\n"
        f"> Collected: {collected}\n"
        f"> Published: {published}\n\n"
        f"{cleaned}\n"
    )


def looks_like_raw(text: str) -> bool:
    head = "\n".join(text.splitlines()[:8])
    return head.startswith("# ") and "> Source:" in head and "> Collected:" in head


def unique_raw_path(raw_root: Path, topic: str, collected: str, slug: str) -> Path:
    folder = raw_root / topic
    folder.mkdir(parents=True, exist_ok=True)
    candidate = folder / f"{collected}-{slug}.md"
    number = 2
    while candidate.exists():
        candidate = folder / f"{collected}-{slug}-{number}.md"
        number += 1
    return candidate


def unique_destination(folder: Path, filename: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    candidate = folder / filename
    if not candidate.exists():
        return candidate
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    number = 2
    while True:
        candidate = folder / f"{stem}-{number}{suffix}"
        if not candidate.exists():
            return candidate
        number += 1
