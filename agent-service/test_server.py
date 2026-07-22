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
        "fragments": [],
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


class DecideTest(unittest.TestCase):
    def test_decide_returns_raw_output_and_does_not_leak_api_key(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "sk-test-secret", "model": "small-model"}
        captured_request = {}
        raw_output = {"notYetValidatedByTransport": "走吧。"}

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            captured_request["authorization"] = request.get_header("Authorization")
            return FakeResponse(_model_response(raw_output, {"prompt_tokens": 12, "completion_tokens": 8}))

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(config, _request())

        self.assertEqual(result["rawOutput"], raw_output)
        self.assertEqual(result["usage"]["outputTokens"], 8)
        self.assertEqual(captured_request["authorization"], "Bearer sk-test-secret")
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
