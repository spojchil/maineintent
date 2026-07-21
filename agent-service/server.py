"""Local HTTP service that turns a DecisionContext into a CompanionDecision.

Runs as a separate process from the Node/Mineflayer side. Node POSTs the raw
DecisionContext (see src/models/contracts.ts) to /v1/decide and receives back
{decision, model, usage}; this process owns the prompt construction, the call
to the OpenAI-compatible endpoint, and decision validation. Only Python stdlib
is used so running it needs nothing beyond `python server.py`.
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
from schema import DecisionValidationError, validate_decision

_DEFAULT_TIMEOUT_S = 45.0


class ConfigError(RuntimeError):
    pass


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
    return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": model, "port": port}


def decide(config: dict, context: dict) -> dict:
    request_body = json.dumps(
        {
            "model": config["model"],
            "temperature": 0.4,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt(context["profile"]["content"])},
                {"role": "user", "content": json.dumps(model_context(context), ensure_ascii=False)},
            ],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{config['base_url']}/chat/completions",
        data=request_body,
        method="POST",
        headers={"authorization": f"Bearer {config['api_key']}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=_DEFAULT_TIMEOUT_S) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(body).get("error", {}).get("message", "unknown error")
        except json.JSONDecodeError:
            message = "unknown error"
        raise RuntimeError(f"Model request failed ({error.code}): {message}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"Model request failed: {error.reason}") from None

    choices = payload.get("choices") or []
    content = (choices[0].get("message", {}).get("content") if choices else None)
    if not content:
        raise RuntimeError("Model response did not contain message content")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as error:
        raise RuntimeError("Model response was not strict JSON") from error

    decision = validate_decision(parsed)
    usage = payload.get("usage") or {}
    result = {"decision": decision, "model": config["model"]}
    if usage:
        result["usage"] = {"inputTokens": usage.get("prompt_tokens"), "outputTokens": usage.get("completion_tokens")}
    return result


def make_handler(config: dict) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format_str: str, *args: object) -> None:
            sys.stderr.write(f"{self.address_string()} - {format_str % args}\n")

        def _send_json(self, status: int, body: dict) -> None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
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
            length = int(self.headers.get("content-length", "0"))
            try:
                context = json.loads(self.rfile.read(length).decode("utf-8"))
            except json.JSONDecodeError:
                self._send_json(400, {"error": "request body was not valid JSON"})
                return
            try:
                result = decide(config, context)
            except DecisionValidationError as error:
                self._send_json(502, {"error": f"model decision failed validation: {error}"})
                return
            except (KeyError, RuntimeError) as error:
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
