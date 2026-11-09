#!/usr/bin/env python3
"""Build the site and serve it locally.

--demo serves an obvious sample document so the question box can be tried
before any committee file has been uploaded. It does not write into wiki/.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import shutil
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_site import build_site  # noqa: E402
from qss.extract import raw_document  # noqa: E402

DEMO_BODY = """This page is a format sample for a local preview. It is not a decision of the QSS Parent Committee.

The sample rule says a book drive is described as approved only after the minutes contain the words "approved in the minutes".

The sample does not mention bake sales, fees, or any real family.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview the knowledge base")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--demo", action="store_true", help="Serve a labeled sample document")
    args = parser.parse_args()
    dest = ROOT / "dist"
    content = ROOT
    sample = False
    if args.demo:
        content = _demo_content()
        sample = True
    build_site(ROOT, dest, content=content, sample=sample)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dest))
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Serving {dest} at http://127.0.0.1:{args.port}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped")
    return 0


def _demo_content() -> Path:
    folder = ROOT / ".preview" / "demo"
    if folder.exists():
        shutil.rmtree(folder)
    raw = folder / "raw" / "committee"
    raw.mkdir(parents=True)
    (folder / "wiki").mkdir()
    (folder / "wiki" / "index.md").write_text("# Knowledge Base Index\n", encoding="utf-8")
    (folder / "wiki" / "log.md").write_text("# Wiki Log\n", encoding="utf-8")
    document = raw_document(
        "Sample preview minutes",
        "local preview only",
        "2026-11-09",
        "Unknown",
        DEMO_BODY,
    )
    (raw / "2026-11-09-sample-preview-minutes.md").write_text(document, encoding="utf-8")
    return folder


if __name__ == "__main__":
    raise SystemExit(main())
