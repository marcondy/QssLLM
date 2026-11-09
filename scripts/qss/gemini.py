"""Call the Gemini REST API. The key is never written to a log."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "gemini-2.5-flash"
API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def api_key() -> str:
    key = (os.environ.get("GEMINI_API_KEY", "") or "").replace("\ufeff", "").strip()
    if len(key) >= 2 and key[0] == key[-1] and key[0] in {'"', "'"}:
        key = key[1:-1].strip()
    if key.endswith("\\n"):
        key = key[:-2].strip()
    return key


def model_name() -> str:
    raw = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    if not _safe_model(raw):
        return DEFAULT_MODEL
    return raw


def _safe_model(value: str) -> bool:
    return bool(value) and len(value) <= 80 and all(ch.isalnum() or ch in ".-" for ch in value)


def generate(system: str, user: str, *, max_output_tokens: int, thinking_budget: int) -> tuple[str, str]:
    key = api_key()
    if not key:
        raise GeminiError("GEMINI_API_KEY is not set")
    body = _body(system, user, max_output_tokens, thinking_budget)
    try:
        return _post(model_name(), key, body)
    except GeminiError as exc:
        if exc.status == 400 and "thinking" in str(exc).lower() and thinking_budget is not None:
            fallback = _body(system, user, max_output_tokens, None)
            return _post(model_name(), key, fallback)
        raise


def _body(system: str, user: str, max_output_tokens: int, thinking_budget: int | None) -> dict:
    generation: dict = {
        "temperature": 0.2,
        "maxOutputTokens": max_output_tokens,
        "responseMimeType": "application/json",
    }
    if thinking_budget is not None:
        generation["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    return {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": generation,
    }


def _post(model: str, key: str, body: dict) -> tuple[str, str]:
    url = f"{API_ROOT}/{model}:generateContent"
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        message = detail
        try:
            message = json.loads(detail)["error"]["message"]
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
        raise GeminiError(f"Gemini returned {exc.code}: {message}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise GeminiError(f"could not reach Gemini: {exc.reason}") from exc
    return _text(payload)


def _text(payload: dict) -> tuple[str, str]:
    candidates = payload.get("candidates") or []
    if not candidates:
        feedback = payload.get("promptFeedback") or {}
        reason = feedback.get("blockReason") or "empty response"
        raise GeminiError(f"Gemini returned no answer ({reason})")
    candidate = candidates[0]
    finish = candidate.get("finishReason") or ""
    parts = (candidate.get("content") or {}).get("parts") or []
    texts = [part.get("text", "") for part in parts if part.get("text") and not part.get("thought")]
    text = "".join(texts).strip()
    if not text:
        raise GeminiError(f"Gemini returned an empty answer ({finish or 'no text'})")
    return text, finish
