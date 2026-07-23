import json
import unittest
from unittest.mock import patch

import server


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, amount: int = -1) -> bytes:
        return self._body if amount < 0 else self._body[:amount]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _context() -> dict:
    return {
        "protocol": "mineintent.context.v2",
        "ref": {"runId": "run-1"},
        "fragments": [{
            "id": "observation-1",
            "section": "observations",
            "content": {"values": {"visibleEntities": [{"ref": "world-target-ref", "type": "sheep"}]}},
        }],
    }


def _request() -> dict:
    return {"context": _context(), "outputSchema": {"type": "object"}}


def _model_response(raw_output: object, usage: object | None = None) -> bytes:
    payload = {
        "choices": [{"message": {"content": json.dumps(raw_output, ensure_ascii=False)}}],
    }
    if usage is not None:
        payload["usage"] = usage
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _assistant_response(message: dict, usage: object | None = None) -> bytes:
    payload = {"choices": [{"message": message}]}
    if usage is not None:
        payload["usage"] = usage
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class DecideTest(unittest.TestCase):
    def test_decide_returns_raw_output_and_does_not_leak_api_key(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "sk-test-secret", "model": "small-model"}
        captured_request = {}
        raw_output = {"notYetValidatedByTransport": "走吧。"}

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            captured_request["authorization"] = request.get_header("Authorization")
            captured_request["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(_model_response(raw_output, {"prompt_tokens": 12, "completion_tokens": 8}))

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(config, _request())

        self.assertEqual(result["rawOutput"], raw_output)
        self.assertEqual(result["usage"]["outputTokens"], 8)
        self.assertEqual(captured_request["authorization"], "Bearer sk-test-secret")
        self.assertEqual(
            set(captured_request["body"]),
            {"model", "response_format", "messages"},
        )
        self.assertNotIn("tools", captured_request["body"])
        self.assertNotIn("tool_choice", captured_request["body"])
        self.assertNotIn("functions", captured_request["body"])
        regular_context = json.loads(captured_request["body"]["messages"][1]["content"])
        self.assertEqual(
            regular_context["fragments"][0]["content"]["values"]["visibleEntities"][0]["ref"],
            "world-target-ref",
        )
        self.assertNotIn("sk-test-secret", json.dumps(result))

    def test_decide_rejects_non_json_content(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            body = json.dumps({"choices": [{"message": {"content": "not json"}}]}).encode("utf-8")
            return FakeResponse(body)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            with self.assertRaisesRegex(RuntimeError, "strict JSON"):
                server.decide(config, _request())

    def test_decide_requires_the_minimal_transport_context(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}
        with self.assertRaisesRegex(server.RequestValidationError, "context and outputSchema"):
            server.decide(config, {"context": _context()})

    def test_decide_drops_invalid_provider_usage(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}
        with patch(
            "urllib.request.urlopen",
            return_value=FakeResponse(_model_response({}, {"prompt_tokens": True, "completion_tokens": -2})),
        ):
            result = server.decide(config, _request())
        self.assertNotIn("usage", result)

    def test_tool_loop_replays_reasoning_content_and_returns_fresh_observation(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "thinking-model"}
        requests = []
        responses = [
            _assistant_response({
                "role": "assistant",
                "content": "",
                "reasoning_content": "羊在右边，我先转过去。",
                "tool_calls": [{
                    "id": "call-look-1",
                    "type": "function",
                    "function": {
                        "name": "look_relative",
                        "arguments": '{"yaw_degrees":35,"pitch_degrees":0}',
                    },
                }],
            }, {"prompt_tokens": 10, "completion_tokens": 2}),
            _model_response({"protocol": "mineintent.decision.v2", "effects": []}, {
                "prompt_tokens": 14, "completion_tokens": 3,
            }),
        ]
        executed = []

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            requests.append(json.loads(request.data.decode("utf-8")))
            return FakeResponse(responses.pop(0))

        def execute(run_id, name, arguments):
            executed.append((run_id, name, arguments))
            return {
                "status": "completed",
                "viewport": {
                    "visibleEntities": [{"ref": "opaque-sheep", "type": "sheep"}],
                    "visibleBlocks": {
                        "blocks": [{"ref": "opaque-stone", "name": "stone", "relativePosition": [1.5, 0, 3.5]}],
                        "truncated": False,
                    },
                },
                "poseDelta": {"yawDegrees": 35},
            }

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(config, _request(), execute)

        self.assertEqual(executed, [("run-1", "look_relative", {"yaw_degrees": 35, "pitch_degrees": 0})])
        self.assertEqual(result["usage"], {"inputTokens": 24, "outputTokens": 5})
        self.assertEqual(
            [tool["function"]["name"] for tool in requests[0]["tools"]],
            ["look_relative", "move_input"],
        )
        experimental_context = json.loads(requests[0]["messages"][1]["content"])
        self.assertNotIn(
            "ref",
            experimental_context["fragments"][0]["content"]["values"]["visibleEntities"][0],
        )
        replay = requests[1]["messages"][-2]
        self.assertEqual(replay["role"], "assistant")
        self.assertEqual(replay["reasoning_content"], "羊在右边，我先转过去。")
        self.assertEqual(replay["tool_calls"][0]["id"], "call-look-1")
        tool_message = requests[1]["messages"][-1]
        self.assertEqual(tool_message["tool_call_id"], "call-look-1")
        tool_content = json.loads(tool_message["content"])
        self.assertEqual(tool_content["viewport"]["visibleEntities"], [{"type": "sheep"}])
        self.assertEqual(tool_content["viewport"]["visibleBlocks"]["blocks"], [["stone", 1.5, 0, 3.5]])

    def test_only_first_parallel_body_call_executes(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}
        first = _assistant_response({
            "content": None,
            "reasoning_content": "先转头再走。",
            "tool_calls": [
                {
                    "id": "call-1", "type": "function",
                    "function": {"name": "look_relative", "arguments": '{"yaw_degrees":10,"pitch_degrees":0}'},
                },
                {
                    "id": "call-2", "type": "function",
                    "function": {"name": "move_input", "arguments": '{"direction":"forward","duration_ms":500}'},
                },
            ],
        })
        second = _model_response({"done": True})
        requests = []
        executed = []

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            requests.append(json.loads(request.data.decode("utf-8")))
            return FakeResponse(first if len(requests) == 1 else second)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            server.decide(config, _request(), lambda run_id, name, args: executed.append((run_id, name, args)) or {"status": "completed"})

        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0][1], "look_relative")
        follow_up_tools = requests[1]["messages"][-2:]
        self.assertEqual(json.loads(follow_up_tools[0]["content"])["status"], "completed")
        self.assertIn("Only one body tool", json.loads(follow_up_tools[1]["content"])["summary"])

    def test_tool_loop_allows_more_than_sixteen_sequential_observations(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}
        responses = [
            _assistant_response({
                "content": None,
                "reasoning_content": f"继续观察 {index}",
                "tool_calls": [{
                    "id": f"call-{index}", "type": "function",
                    "function": {"name": "look_relative", "arguments": '{"yaw_degrees":1,"pitch_degrees":0}'},
                }],
            })
            for index in range(17)
        ]
        responses.append(_model_response({"protocol": "mineintent.decision.v2", "effects": []}))
        executed = []

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            return FakeResponse(responses.pop(0))

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(
                config,
                _request(),
                lambda run_id, name, arguments: executed.append((run_id, name, arguments)) or {"status": "completed"},
            )

        self.assertEqual(len(executed), 17)
        self.assertEqual(result["rawOutput"]["protocol"], "mineintent.decision.v2")

    def test_invalid_tool_arguments_are_returned_to_the_model_without_execution(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}
        responses = [
            _assistant_response({
                "content": "", "reasoning_content": "移动。",
                "tool_calls": [{
                    "id": "bad-call", "type": "function",
                    "function": {"name": "move_input", "arguments": '{"direction":"forward","duration_ms":9999}'},
                }],
            }),
            _model_response({"corrected": True}),
        ]
        requests = []

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            requests.append(json.loads(request.data.decode("utf-8")))
            return FakeResponse(responses.pop(0))

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(config, _request(), lambda *_args: self.fail("invalid call must not execute"))

        self.assertEqual(result["rawOutput"], {"corrected": True})
        error_result = json.loads(requests[1]["messages"][-1]["content"])
        self.assertEqual(error_result["status"], "failed")
        self.assertIn("duration_ms", error_result["summary"])


class HttpToolExecutorTest(unittest.TestCase):
    def test_posts_only_run_name_and_arguments_with_bearer_token(self) -> None:
        captured = {}

        class FakeOpener:
            def open(self, request, timeout=None):  # noqa: ARG002
                captured["url"] = request.full_url
                captured["authorization"] = request.get_header("Authorization")
                captured["content_type"] = request.get_header("Content-type")
                captured["body"] = json.loads(request.data.decode("utf-8"))
                return FakeResponse(json.dumps({"status": "completed", "viewport": {}}).encode("utf-8"))

        with patch("urllib.request.build_opener", return_value=FakeOpener()):
            execute = server.http_tool_executor(
                "http://127.0.0.1:43210/v1/experiment/d40/tool",
                "test-callback-token-long-enough",
            )
            result = execute("run-1", "move_input", {"direction": "forward", "duration_ms": 500, "sprint": False})

        self.assertEqual(result["status"], "completed")
        self.assertEqual(captured["url"], "http://127.0.0.1:43210/v1/experiment/d40/tool")
        self.assertEqual(captured["authorization"], "Bearer test-callback-token-long-enough")
        self.assertEqual(captured["content_type"], "application/json")
        self.assertEqual(set(captured["body"]), {"runId", "name", "arguments"})
        self.assertEqual(captured["body"]["name"], "move_input")

    def test_rejects_non_loopback_or_credentialed_executor_urls(self) -> None:
        token = "test-callback-token-long-enough"
        for url in (
            "https://127.0.0.1/tool",
            "http://example.com/tool",
            "http://user@127.0.0.1/tool",
            "http://127.0.0.1/tool#fragment",
        ):
            with self.subTest(url=url):
                with self.assertRaises(server.RequestValidationError):
                    server.http_tool_executor(url, token)


class StrictJsonTest(unittest.TestCase):
    def test_accepts_unicode_scalar_values(self) -> None:
        value = {"message": "一起玩😀"}
        self.assertEqual(server.strict_json_loads(server.strict_json_dumps(value)), value)

    def test_rejects_non_standard_numbers(self) -> None:
        for raw in ("NaN", "Infinity", "-Infinity", "9007199254740992"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    server.strict_json_loads(raw)
        with self.assertRaises(ValueError):
            server.strict_json_dumps({"value": float("nan")})

    def test_rejects_unpaired_surrogates(self) -> None:
        with self.assertRaises(ValueError):
            server.strict_json_loads('"\\ud800"')

    def test_enforces_utf8_byte_budget(self) -> None:
        with self.assertRaisesRegex(ValueError, "exceeds"):
            server.strict_json_dumps({"value": "界" * server._MAX_JSON_BYTES})


class ConfigTest(unittest.TestCase):
    def test_rejects_invalid_port_range(self) -> None:
        env = {
            "MINEINTENT_MODEL_BASE_URL": "https://model.invalid/v1",
            "MINEINTENT_MODEL_API_KEY": "key",
            "MINEINTENT_MODEL": "model",
            "MINEINTENT_AGENT_SERVICE_PORT": "70000",
        }
        with self.assertRaisesRegex(server.ConfigError, "between 1 and 65535"):
            server.load_config(env)


if __name__ == "__main__":
    unittest.main()
