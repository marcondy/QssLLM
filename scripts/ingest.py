#!/usr/bin/env python3
"""Copy inbox uploads into raw/ and compile wiki pages when Gemini is configured."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from qss.compile import compile_source, today  # noqa: E402
from qss.extract import (  # noqa: E402
    extract_text,
    guess_title,
    iter_inbox,
    looks_like_raw,
    raw_document,
    slugify,
    topic_for,
    unique_destination,
    unique_raw_path,
)

MAX_BYTES = 15 * 1024 * 1024


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest inbox documents into the wiki")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    result = ingest(root)
    print(json.dumps({key: result[key] for key in ("processed", "failed")}, ensure_ascii=False, indent=2))
    return 0


def ingest(root: Path) -> dict:
    inbox = root / "inbox"
    state_path = root / "ingest-state.json"
    state = _load_state(state_path)
    collected = today()
    processed = []
    failed = []
    for path in iter_inbox(inbox):
        digest = _sha256(path)
        if digest in state["files"]:
            _retire_duplicate(root, path, state["files"][digest])
            processed.append({"file": str(path.relative_to(root)), "skipped": "already ingested"})
            continue
        if path.stat().st_size > MAX_BYTES:
            _fail_file(root, path, "file is larger than 15 MB")
            failed.append({"file": path.name, "error": "too large"})
            continue
        try:
            raw_rel, source_rel = _store_raw(root, inbox, path, collected)
        except Exception as exc:  # keep going so one bad file does not block the rest
            _fail_file(root, path, str(exc))
            failed.append({"file": path.name, "error": str(exc)})
            print(f"::warning::Could not read {path.name}: {exc}")
            continue
        state["files"][digest] = {"raw": raw_rel, "source": source_rel, "collected": collected}
        _save_state(state_path, state)
        compile_result = compile_source(root, raw_rel, collected)
        if not compile_result.get("ok", False):
            print(f"::warning::Saved {raw_rel} but did not compile a wiki page.")
        processed.append({"raw": raw_rel, "compile": compile_result.get("reason") or "compiled"})
    return {"processed": processed, "failed": len(failed), "errors": failed}


def _store_raw(root: Path, inbox: Path, path: Path, collected: str) -> tuple[str, str]:
    topic = topic_for(inbox, path)
    text = extract_text(path).strip()
    if not text:
        raise ValueError("no text found")
    title = guess_title(text, path.name)
    source_path = unique_destination(root / "sources" / topic, path.name)
    source_rel = source_path.relative_to(root).as_posix()
    if looks_like_raw(text):
        document = text if text.endswith("\n") else text + "\n"
    else:
        document = raw_document(title, source_rel, collected, "Unknown", text)
    raw_path = unique_raw_path(root / "raw", topic, collected, slugify(path.name))
    raw_path.write_text(document, encoding="utf-8")
    shutil.move(str(path), source_path)
    return raw_path.relative_to(root).as_posix(), source_rel


def _retire_duplicate(root: Path, path: Path, prior: dict) -> None:
    """Move a re-uploaded copy aside without compiling it again."""
    failed = root / "inbox" / "_failed"
    dest = unique_destination(failed, path.name + ".duplicate")
    shutil.move(str(path), dest)
    print(f"::warning::{path.name} was already ingested as {prior.get('raw', 'a raw file')}.")


def _fail_file(root: Path, path: Path, message: str) -> None:
    dest = unique_destination(root / "inbox" / "_failed", path.name)
    try:
        shutil.move(str(path), dest)
        note = dest.with_suffix(dest.suffix + ".error.txt")
        note.write_text(message + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"::warning::Could not move failed upload {path.name}: {exc}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _load_state(path: Path) -> dict:
    if not path.is_file():
        return {"files": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("files", {})
    return data


def _save_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
