#!/usr/bin/env python3
"""Assemble the static site, including a generated config and search corpus."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from qss.corpus import build_corpus  # noqa: E402
from qss.gemini import DEFAULT_MODEL  # noqa: E402

KEY_ALPHABET = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the GitHub Pages site")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--content", type=Path, default=None, help="Wiki content root, if different from --root")
    parser.add_argument("--dest", type=Path, default=None)
    parser.add_argument("--sample", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    dest = (args.dest or root / "dist").resolve()
    content = (args.content or root).resolve()
    build_site(root, dest, content=content, sample=args.sample)
    print(dest)
    return 0


def build_site(repo: Path, dest: Path, content: Path | None = None, sample: bool = False) -> None:
    content = content or repo
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    site = repo / "site"
    for item in site.iterdir():
        if item.name == "config.example.js":
            continue
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    for folder in ("wiki", "raw", "sources"):
        src = content / folder
        if not src.is_dir():
            continue
        shutil.copytree(
            src,
            dest / folder,
            ignore=shutil.ignore_patterns(".gitkeep", "_failed", "*.error.txt"),
        )
    corpus = build_corpus(content)
    corpus["built"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    corpus["sample"] = sample
    (dest / "corpus.json").write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_config(dest / "config.js", sample=sample)


def write_config(path: Path, sample: bool = False) -> None:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key and not _safe_key(key):
        print("::warning::GEMINI_API_KEY has unexpected characters, so the published site will not include it.")
        key = ""
    model = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    if not model or len(model) > 80 or any(not (ch.isalnum() or ch in ".-") for ch in model):
        model = DEFAULT_MODEL
    payload = {"apiKey": key, "model": model, "sample": sample}
    path.write_text("window.QSS_CONFIG = " + json.dumps(payload) + ";\n", encoding="utf-8")


def _safe_key(key: str) -> bool:
    return 10 <= len(key) <= 256 and set(key) <= KEY_ALPHABET


if __name__ == "__main__":
    raise SystemExit(main())
