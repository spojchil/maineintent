"""Local model transport for MineIntent decisions.

This process owns prompt construction and the OpenAI-compatible request. It
deliberately does not own the decision business schema: strict model JSON is
returned as ``rawOutput`` and validated once by the TypeScript runtime.
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from prompt import (
    d40_observation_for_model,
    d40_model_context,
    d40_system_prompt,
    regular_model_context,
    regular_system_prompt,
)

_DEFAULT_TIMEOUT_S = 45.0
_MAX_JSON_BYTES = 1_048_576
_MAX_TOOL_RESULT_BYTES = 262_144
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_TOOL_ROUNDS = 64

_D40_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "look_relative",
            "description": (
                "Turn the current first-person view by a short relative angle, then observe the fresh viewport. "
                "Positive yaw turns right; negative yaw turns left. Positive pitch looks down; negative pitch looks up. "
                "Call only one body tool per assistant sub-turn and inspect its result before acting again."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "yaw_degrees": {
                        "type": "number",
                        "minimum": -90,
                        "maximum": 90,
                        "description": "Horizontal turn relative to the current view, in degrees.",
                    },
                    "pitch_degrees": {
                        "type": "number",
                        "minimum": -90,
                        "maximum": 90,
                        "description": "Vertical turn relative to the current view, in degrees.",
                    },
                },
                "required": ["yaw_degrees", "pitch_degrees"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_input",
            "description": (
                "Hold one movement input for a short duration, release it, then observe actual pose change and the fresh viewport. "
                "Use repeated short calls instead of assuming that a route is clear. "
                "Call only one body tool per assistant sub-turn and inspect its result before acting again."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["forward", "back", "left", "right"],
                        "description": "Movement direction relative to the current view.",
                    },
                    "duration_ms": {
                        "type": "integer",
                        "minimum": 50,
                        "maximum": 1500,
                        "description": "How long to hold the movement input.",
                    },
                    "sprint": {
                        "type": "boolean",
                        "description": "Whether to hold sprint during this short movement. Defaults to false.",
                    },
                },
                "required": ["direction", "duration_ms"],
                "additionalProperties": False,
            },
        },
    },
]

ToolExecutor = Callable[[str, str, dict], object]


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):  # noqa: ANN001, ARG002
        return None


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


def http_tool_executor(url: str, token: str) -> ToolExecutor:
    if len(url) > 2_048 or "\r" in url or "\n" in url:
        raise RequestValidationError("D40 tool executor URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise RequestValidationError("D40 tool executor must be an uncredentialed loopback HTTP URL")
    try:
        parsed.port
    except ValueError as error:
        raise RequestValidationError("D40 tool executor URL has an invalid port") from error
    if len(token) < 16 or len(token) > 512 or "\r" in token or "\n" in token:
        raise RequestValidationError("D40 tool executor token must contain 16-512 safe header characters")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())

    def execute(run_id: str, name: str, arguments: dict) -> object:
        body = strict_json_dumps({"runId": run_id, "name": name, "arguments": arguments})
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
            },
        )
        try:
            with opener.open(request, timeout=_DEFAULT_TIMEOUT_S) as response:
                raw_payload = response.read(_MAX_TOOL_RESULT_BYTES + 1)
                if len(raw_payload) > _MAX_TOOL_RESULT_BYTES:
                    raise RuntimeError("D40 tool executor response exceeded the JSON byte limit")
                return strict_json_loads(raw_payload)
        except urllib.error.HTTPError as error:
            body = error.read(_MAX_TOOL_RESULT_BYTES + 1)
            try:
                parsed_error = strict_json_loads(body)
                message = (
                    parsed_error.get("error", "unknown error")
                    if isinstance(parsed_error, dict)
                    else "unknown error"
                )
            except (UnicodeError, ValueError, json.JSONDecodeError):
                message = "unknown error"
            raise RuntimeError(f"D40 tool executor failed ({error.code}): {message}") from None
        except urllib.error.URLError as error:
            raise RuntimeError(f"D40 tool executor failed: {error.reason}") from None

    return execute


def _model_completion(config: dict, messages: list[dict], *, enable_tools: bool) -> dict:
    body = {
        "model": config["model"],
        "response_format": {"type": "json_object"},
        "messages": messages,
    }
    if enable_tools:
        body.update({"tools": _D40_TOOLS, "tool_choice": "auto"})
    request_body = strict_json_dumps(body)
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
    return payload


def _message_from(payload: dict) -> dict:
    choices = payload.get("choices")
    first_choice = choices[0] if isinstance(choices, list) and choices else None
    message = first_choice.get("message") if isinstance(first_choice, dict) else None
    if not isinstance(message, dict):
        raise RuntimeError("Model response did not contain an assistant message")
    return message


def _add_usage(total: dict[str, int], payload: dict) -> None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return
    for provider_key, result_key in (("prompt_tokens", "inputTokens"), ("completion_tokens", "outputTokens")):
        value = usage.get(provider_key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            total[result_key] = total.get(result_key, 0) + value


def _assistant_tool_message(message: dict, tool_calls: list) -> dict:
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        raise RuntimeError("Model tool-call content must be a string or null")
    replay = {"role": "assistant", "content": content, "tool_calls": tool_calls}
    if "reasoning_content" in message:
        reasoning_content = message["reasoning_content"]
        if reasoning_content is not None and not isinstance(reasoning_content, str):
            raise RuntimeError("Model reasoning_content must be a string or null")
        replay["reasoning_content"] = reasoning_content
    return replay


def _tool_call_id(value: object) -> str:
    if not isinstance(value, dict):
        raise RuntimeError("Model tool call must be a JSON object")
    tool_call_id = value.get("id")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        raise RuntimeError("Model tool call did not contain an id")
    return tool_call_id


def _bounded_number(value: object, minimum: float, maximum: float, field: str) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field} must be a finite number")
    if value < minimum or value > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return value


def _tool_name_and_arguments(tool_call: object) -> tuple[str, dict]:
    if not isinstance(tool_call, dict) or tool_call.get("type") != "function":
        raise ValueError("only function tool calls are supported")
    function = tool_call.get("function")
    if not isinstance(function, dict):
        raise ValueError("tool call function must be an object")
    name = function.get("name")
    if not isinstance(name, str):
        raise ValueError("tool call function name must be a string")
    raw_arguments = function.get("arguments")
    if not isinstance(raw_arguments, str):
        raise ValueError("tool call arguments must be a JSON string")
    try:
        arguments = strict_json_loads(raw_arguments)
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("tool call arguments were not strict JSON") from error
    if not isinstance(arguments, dict):
        raise ValueError("tool call arguments must decode to an object")

    if name == "look_relative":
        if set(arguments) != {"yaw_degrees", "pitch_degrees"}:
            raise ValueError("look_relative requires only yaw_degrees and pitch_degrees")
        return name, {
            "yaw_degrees": _bounded_number(arguments["yaw_degrees"], -90, 90, "yaw_degrees"),
            "pitch_degrees": _bounded_number(arguments["pitch_degrees"], -90, 90, "pitch_degrees"),
        }
    if name == "move_input":
        if not {"direction", "duration_ms"} <= arguments.keys() or arguments.keys() - {"direction", "duration_ms", "sprint"}:
            raise ValueError("move_input requires direction and duration_ms, with optional sprint")
        direction = arguments["direction"]
        if direction not in {"forward", "back", "left", "right"}:
            raise ValueError("direction must be forward, back, left, or right")
        duration_ms = arguments["duration_ms"]
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or not 50 <= duration_ms <= 1500:
            raise ValueError("duration_ms must be an integer between 50 and 1500")
        sprint = arguments.get("sprint", False)
        if not isinstance(sprint, bool):
            raise ValueError("sprint must be a boolean")
        return name, {"direction": direction, "duration_ms": duration_ms, "sprint": sprint}
    raise ValueError(f"unknown body tool {name!r}")


def _tool_result(
    execute_tool: ToolExecutor,
    run_id: str,
    tool_call: object,
    *,
    execute: bool,
) -> tuple[str, object]:
    tool_call_id = _tool_call_id(tool_call)
    if not execute:
        return tool_call_id, {
            "status": "failed",
            "summary": "Only one body tool is executed per assistant sub-turn; inspect the first result and call again.",
        }
    try:
        name, arguments = _tool_name_and_arguments(tool_call)
    except ValueError as error:
        return tool_call_id, {"status": "failed", "summary": str(error)}
    result = execute_tool(run_id, name, arguments)
    if not isinstance(result, dict):
        raise RuntimeError("Tool executor response must be a JSON object")
    return tool_call_id, d40_observation_for_model(result)


def decide(config: dict, request_value: object, execute_tool: ToolExecutor | None = None) -> dict:
    context, output_schema = _require_request(request_value)
    run_id = context["ref"]["runId"]
    experimental = execute_tool is not None
    messages = [
        {
            "role": "system",
            "content": d40_system_prompt(output_schema) if experimental else regular_system_prompt(output_schema),
        },
        {
            "role": "user",
            "content": strict_json_dumps(
                d40_model_context(context) if experimental else regular_model_context(context)
            ).decode("utf-8"),
        },
    ]
    total_usage: dict[str, int] = {}

    for tool_round in range(_MAX_TOOL_ROUNDS + 1):
        payload = _model_completion(config, messages, enable_tools=experimental)
        _add_usage(total_usage, payload)
        message = _message_from(payload)
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            if not experimental:
                raise RuntimeError("Model returned an unsolicited tool call during a no-tool decision")
            if tool_round >= _MAX_TOOL_ROUNDS:
                raise RuntimeError(f"Model exceeded the {_MAX_TOOL_ROUNDS}-round body tool limit")
            messages.append(_assistant_tool_message(message, tool_calls))
            seen_ids: set[str] = set()
            for index, tool_call in enumerate(tool_calls):
                tool_call_id = _tool_call_id(tool_call)
                if tool_call_id in seen_ids:
                    raise RuntimeError("Model returned duplicate tool call ids")
                seen_ids.add(tool_call_id)
                tool_call_id, tool_output = _tool_result(
                    execute_tool, run_id, tool_call, execute=index == 0,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": strict_json_dumps(tool_output).decode("utf-8"),
                })
            continue
        if tool_calls is not None and not isinstance(tool_calls, list):
            raise RuntimeError("Model tool_calls must be an array or null")

        content = message.get("content")
        if not isinstance(content, str) or not content:
            raise RuntimeError("Model response did not contain message content")
        try:
            parsed = strict_json_loads(content)
        except (UnicodeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError("Model response was not strict JSON") from error

        result = {"rawOutput": parsed, "model": config["model"]}
        if total_usage:
            result["usage"] = total_usage
        return result

    raise AssertionError("unreachable")


def make_handler(config: dict, execute_tool: ToolExecutor | None = None) -> type[BaseHTTPRequestHandler]:
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
                request_executor = execute_tool
                executor_url = self.headers.get("x-mineintent-tool-executor-url")
                executor_token = self.headers.get("x-mineintent-tool-executor-token")
                if request_executor is None and (executor_url is not None or executor_token is not None):
                    if executor_url is None or executor_token is None:
                        raise RequestValidationError("D40 tool executor URL and token must be supplied together")
                    request_executor = http_tool_executor(executor_url, executor_token)
                result = decide(config, context, request_executor)
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
