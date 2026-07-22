"""Local model transport for MineIntent decisions.

This process owns prompt construction and the OpenAI-compatible request. It
deliberately does not own the decision business schema: strict model JSON is
returned as ``rawOutput`` and validated once by the TypeScript runtime.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from prompt import model_context, system_prompt

_DEFAULT_TIMEOUT_S = 45.0
_MAX_JSON_BYTES = 1_048_576
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class ConfigError(RuntimeError):
    pass


class RequestValidationError(ValueError):
    pass


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value!r}")


def _validate_json_value(root: object) -> None:
    pending = [root]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            try:
                value.encode("utf-8", errors="strict")
            except UnicodeEncodeError as error:
                raise ValueError("JSON contains an unpaired Unicode surrogate") from error
        elif isinstance(value, int) and not isinstance(value, bool):
            if abs(value) > _MAX_SAFE_INTEGER:
                raise ValueError("JSON contains an integer outside the interoperable safe range")
        elif isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                raise ValueError("JSON contains a non-finite number")
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError("JSON object keys must be strings")
                pending.extend((key, item))


def strict_json_loads(raw: bytes | str) -> object:
    if isinstance(raw, bytes):
        if len(raw) > _MAX_JSON_BYTES:
            raise ValueError(f"JSON exceeds {_MAX_JSON_BYTES} bytes")
        text = raw.decode("utf-8", errors="strict")
    else:
        if len(raw.encode("utf-8", errors="strict")) > _MAX_JSON_BYTES:
            raise ValueError(f"JSON exceeds {_MAX_JSON_BYTES} bytes")
        text = raw
    value = json.loads(text, parse_constant=_reject_json_constant)
    _validate_json_value(value)
    return value


def strict_json_dumps(value: object, *, ensure_ascii: bool = False) -> bytes:
    _validate_json_value(value)
    payload = json.dumps(
        value,
        ensure_ascii=ensure_ascii,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(payload) > _MAX_JSON_BYTES:
        raise ValueError(f"JSON exceeds {_MAX_JSON_BYTES} bytes")
    return payload


def _require_request(value: object) -> tuple[dict, dict]:
    if not isinstance(value, dict):
        raise RequestValidationError("request body must be a JSON object")
    if set(value) != {"context", "outputSchema"}:
        raise RequestValidationError("request body must contain only context and outputSchema")
    context = value.get("context")
    output_schema = value.get("outputSchema")
    if not isinstance(context, dict) or context.get("protocol") != "mineintent.context.v2":
        raise RequestValidationError("context must use mineintent.context.v2")
    ref = context.get("ref")
    if not isinstance(ref, dict) or not isinstance(ref.get("runId"), str) or not ref["runId"]:
        raise RequestValidationError("context.ref.runId must be a non-empty string")
    if not isinstance(output_schema, dict):
        raise RequestValidationError("outputSchema must be a JSON object")
    return context, output_schema


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def load_config(env: dict = os.environ) -> dict:
    base_url = env.get("MINEINTENT_MODEL_BASE_URL", "").strip()
    api_key = env.get("MINEINTENT_MODEL_API_KEY", "").strip()
    model = env.get("MINEINTENT_MODEL", "").strip()
    if not base_url:
        raise ConfigError("MINEINTENT_MODEL_BASE_URL is required")
    if not api_key:
        raise ConfigError("MINEINTENT_MODEL_API_KEY is required")
    if not model:
        raise ConfigError("MINEINTENT_MODEL is required")
    port_raw = env.get("MINEINTENT_AGENT_SERVICE_PORT", "8765").strip()
    try:
        port = int(port_raw)
    except ValueError as error:
        raise ConfigError("MINEINTENT_AGENT_SERVICE_PORT must be an integer") from error
    if port < 1 or port > 65_535:
        raise ConfigError("MINEINTENT_AGENT_SERVICE_PORT must be between 1 and 65535")
    return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": model, "port": port}


def decide(config: dict, request_value: object) -> dict:
    context, output_schema = _require_request(request_value)
    request_body = strict_json_dumps(
        {
            "model": config["model"],
            "temperature": 0.4,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt(output_schema)},
                {"role": "user", "content": strict_json_dumps(model_context(context)).decode("utf-8")},
            ],
        }
    )
    request = urllib.request.Request(
        f"{config['base_url']}/chat/completions",
        data=request_body,
        method="POST",
        headers={"authorization": f"Bearer {config['api_key']}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=_DEFAULT_TIMEOUT_S) as response:
            raw_payload = response.read(_MAX_JSON_BYTES + 1)
            if len(raw_payload) > _MAX_JSON_BYTES:
                raise RuntimeError("Model response exceeded the JSON byte limit")
            payload = strict_json_loads(raw_payload)
    except urllib.error.HTTPError as error:
        body = error.read(_MAX_JSON_BYTES + 1)
        try:
            parsed_error = strict_json_loads(body)
            message = (
                parsed_error.get("error", {}).get("message", "unknown error")
                if isinstance(parsed_error, dict) and isinstance(parsed_error.get("error"), dict)
                else "unknown error"
            )
        except (UnicodeError, ValueError, json.JSONDecodeError):
            message = "unknown error"
        raise RuntimeError(f"Model request failed ({error.code}): {message}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"Model request failed: {error.reason}") from None

    if not isinstance(payload, dict):
        raise RuntimeError("Model response must be a JSON object")
    choices = payload.get("choices")
    first_choice = choices[0] if isinstance(choices, list) and choices else None
    message = first_choice.get("message") if isinstance(first_choice, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content:
        raise RuntimeError("Model response did not contain message content")
    try:
        parsed = strict_json_loads(content)
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Model response was not strict JSON") from error

    result = {"rawOutput": parsed, "model": config["model"]}
    usage = payload.get("usage")
    if isinstance(usage, dict):
        clean_usage = {}
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        if isinstance(prompt_tokens, int) and not isinstance(prompt_tokens, bool) and prompt_tokens >= 0:
            clean_usage["inputTokens"] = prompt_tokens
        if isinstance(completion_tokens, int) and not isinstance(completion_tokens, bool) and completion_tokens >= 0:
            clean_usage["outputTokens"] = completion_tokens
        if clean_usage:
            result["usage"] = clean_usage
    return result


def make_handler(config: dict) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format_str: str, *args: object) -> None:
            sys.stderr.write(f"{self.address_string()} - {format_str % args}\n")

        def _send_json(self, status: int, body: dict) -> None:
            payload = strict_json_dumps(body)
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler naming)
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/decide":
                self._send_json(404, {"error": "not found"})
                return
            content_type = self.headers.get("content-type", "").partition(";")[0].strip().lower()
            if content_type != "application/json":
                self._send_json(415, {"error": "content-type must be application/json"})
                return
            try:
                length = int(self.headers.get("content-length", ""))
            except ValueError:
                self._send_json(411, {"error": "a valid content-length is required"})
                return
            if length < 0:
                self._send_json(400, {"error": "content-length must not be negative"})
                return
            if length > _MAX_JSON_BYTES:
                self._send_json(413, {"error": f"request body exceeds {_MAX_JSON_BYTES} bytes"})
                return
            try:
                context = strict_json_loads(self.rfile.read(length))
            except (UnicodeError, ValueError, json.JSONDecodeError):
                self._send_json(400, {"error": "request body was not valid strict JSON"})
                return
            try:
                result = decide(config, context)
            except RequestValidationError as error:
                self._send_json(400, {"error": str(error)})
                return
            except (KeyError, RuntimeError, ValueError) as error:
                self._send_json(502, {"error": str(error)})
                return
            self._send_json(200, result)

    return Handler


def main() -> None:
    _load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    config = load_config()
    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), make_handler(config))
    print(f"MineIntent agent service listening on http://127.0.0.1:{config['port']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except ConfigError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        sys.exit(1)
