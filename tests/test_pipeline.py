import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from qss.compile import (  # noqa: E402
    content_word_support,
    ensure_article_header,
    parse_compile_payload,
    rebuild_index,
    safe_article_path,
)
from qss.corpus import build_corpus  # noqa: E402
from qss.extract import extract_text, raw_document  # noqa: E402
from build_site import build_site, write_config  # noqa: E402
from ingest import ingest  # noqa: E402


RAW = """The sample minutes say the book drive is approved in the minutes.
No other activity is described.
"""


class ExtractTests(unittest.TestCase):
    def test_text_html_and_docx(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            text = folder / "notes.txt"
            text.write_text("Parents asked about the book drive.\n", encoding="utf-8")
            self.assertIn("book drive", extract_text(text))

            page = folder / "page.html"
            page.write_text("<html><script>alert(1)</script><p>The book drive is approved.</p></html>", encoding="utf-8")
            html_text = extract_text(page)
            self.assertIn("book drive", html_text)
            self.assertNotIn("alert", html_text)

            docx = folder / "notes.docx"
            xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>The book drive is approved in the minutes.</w:t></w:r></w:p></w:body>
</w:document>"""
            with zipfile.ZipFile(docx, "w") as archive:
                archive.writestr("word/document.xml", xml)
            self.assertIn("approved in the minutes", extract_text(docx))


class CompileGuardTests(unittest.TestCase):
    def test_rejects_paths_outside_the_wiki(self):
        self.assertIsNone(safe_article_path("wiki/../../secrets.md"))
        self.assertIsNone(safe_article_path("wiki/index.md"))
        self.assertIsNone(safe_article_path("raw/committee/file.md"))
        self.assertEqual(safe_article_path("wiki/committee/book-drive.md"), "wiki/committee/book-drive.md")

    def test_header_points_at_the_raw_file(self):
        article = ensure_article_header("# Book drive\n\n## Overview\n\nThe book drive is approved in the minutes.\n", "raw/committee/2026-11-09-minutes.md", "2026-11-09")
        self.assertIn("../../raw/committee/2026-11-09-minutes.md", article)
        self.assertIn("> Updated: 2026-11-09", article)

    def test_word_support_blocks_an_invented_rule(self):
        raw = raw_document("Minutes", "inbox/minutes.txt", "2026-11-09", "Unknown", RAW)
        grounded = ensure_article_header(
            "# Book drive\n\n## Overview\n\nThe book drive is approved in the minutes.\n",
            "raw/committee/minutes.md",
            "2026-11-09",
        )
        invented = ensure_article_header(
            "# Fees\n\n## Overview\n\nEvery family must pay a registration fee before September.\n",
            "raw/committee/minutes.md",
            "2026-11-09",
        )
        self.assertGreaterEqual(content_word_support(grounded, raw), 0.5)
        self.assertLess(content_word_support(invented, raw), 0.5)

    def test_index_rebuild_and_json_parse(self):
        payload = parse_compile_payload('```json\n{"disposition":"New","articles":[]}\n```')
        self.assertEqual(payload["disposition"], "New")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article = root / "wiki" / "committee" / "book-drive.md"
            article.parent.mkdir(parents=True)
            article.write_text(
                ensure_article_header(
                    "# Book drive\n\n## Overview\n\nThe book drive is approved in the minutes.\n",
                    "raw/committee/minutes.md",
                    "2026-11-09",
                ),
                encoding="utf-8",
            )
            (root / "wiki" / "index.md").write_text("# Knowledge Base Index\n", encoding="utf-8")
            (root / "wiki" / "log.md").write_text("# Wiki Log\n", encoding="utf-8")
            rebuild_index(root, {"wiki/committee/book-drive.md": "The book drive is approved in the minutes."})
            index = (root / "wiki" / "index.md").read_text(encoding="utf-8")
            self.assertIn("[Book drive](committee/book-drive.md)", index)
            self.assertIn("2026-11-09", index)


class IngestAndSiteTests(unittest.TestCase):
    def test_ingest_without_a_key_keeps_the_source_searchable(self):
        os.environ.pop("GEMINI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("raw", "wiki", "inbox", "sources"):
                (root / name).mkdir()
            (root / "wiki" / "index.md").write_text("# Knowledge Base Index\n", encoding="utf-8")
            (root / "wiki" / "log.md").write_text("# Wiki Log\n", encoding="utf-8")
            (root / "inbox" / "minutes.txt").write_text(RAW, encoding="utf-8")
            (root / "ingest-state.json").write_text('{"files": {}}\n', encoding="utf-8")
            skill = root / ".agents" / "skills" / "karpathy-llm-wiki" / "scripts"
            skill.mkdir(parents=True)
            result = ingest(root)
            self.assertEqual(result["failed"], 0)
            raws = list((root / "raw").rglob("*.md"))
            self.assertEqual(len(raws), 1)
            self.assertIn("approved in the minutes", raws[0].read_text(encoding="utf-8"))
            self.assertFalse((root / "inbox" / "minutes.txt").exists())
            corpus = build_corpus(root)
            self.assertEqual(corpus["articles"][0]["kind"], "raw")
            self.assertIn("book drive", corpus["chunks"][0]["text"])

    def test_config_keeps_a_normal_key_and_drops_markup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.js"
            os.environ["GEMINI_API_KEY"] = 'AIza"></script>'
            os.environ["GEMINI_MODEL"] = "gemini-2.5-flash"
            try:
                write_config(path)
                text = path.read_text(encoding="utf-8")
                self.assertIn('"apiKey": ""', text)
                self.assertNotIn("script", text)
            finally:
                os.environ.pop("GEMINI_API_KEY", None)

            os.environ["GEMINI_API_KEY"] = "AIzaSyTESTKEY123456"
            try:
                write_config(path)
                payload = json.loads(path.read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
                self.assertEqual(payload["apiKey"], "AIzaSyTESTKEY123456")
            finally:
                os.environ.pop("GEMINI_API_KEY", None)

            os.environ["GEMINI_API_KEY"] = '  "AIzaSyTESTKEY123456"  \n'
            try:
                write_config(path)
                payload = json.loads(path.read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
                self.assertEqual(payload["apiKey"], "AIzaSyTESTKEY123456")
            finally:
                os.environ.pop("GEMINI_API_KEY", None)

    def test_failed_upload_stays_visible_in_sources(self):
        os.environ.pop("GEMINI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("raw", "wiki", "inbox", "sources"):
                (root / name).mkdir()
            (root / "wiki" / "index.md").write_text("# Knowledge Base Index\n", encoding="utf-8")
            (root / "wiki" / "log.md").write_text("# Wiki Log\n", encoding="utf-8")
            (root / "inbox" / "scan.pdf").write_bytes(b"%PDF-1.4 empty")
            (root / "ingest-state.json").write_text('{"files": {}}\n', encoding="utf-8")
            result = ingest(root)
            self.assertEqual(result["failed"], 1)
            failed = list((root / "sources" / "_failed").glob("*"))
            self.assertTrue(any(path.name == "scan.pdf" for path in failed))
            self.assertTrue(any(path.name.endswith(".error.txt") for path in failed))
            log = (root / "wiki" / "log.md").read_text(encoding="utf-8")
            self.assertIn("failed:", log)
            self.assertFalse((root / "inbox" / "scan.pdf").exists())
            self.assertEqual(list((root / "raw").rglob("*.md")), [])

    def test_site_build_copies_wiki_and_not_the_key_into_markdown(self):
        os.environ.pop("GEMINI_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "dist"
            build_site(ROOT, dest, content=ROOT, sample=False)
            self.assertTrue((dest / "index.html").is_file())
            self.assertTrue((dest / "corpus.json").is_file())
            config = (dest / "config.js").read_text(encoding="utf-8")
            self.assertIn('"apiKey": ""', config)
            corpus = json.loads((dest / "corpus.json").read_text(encoding="utf-8"))
            self.assertEqual(corpus["articles"], [])
            self.assertIn("Knowledge Base Index", (dest / "wiki" / "index.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
