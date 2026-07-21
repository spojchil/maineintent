import json
import unittest
from unittest.mock import patch

import server
from schema import DecisionValidationError, validate_decision


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _context() -> dict:
    return {
        "runId": "run-1",
        "trigger": {"type": "player_chat", "text": "一起收集木头吧", "eventId": "event-1"},
        "primaryPlayer": "Alex",
        "profile": {"profileId": "test", "versionId": "v1", "content": "你是伙伴。", "sourcePath": "profile.md"},
        "snapshot": {
            "world": {"worldId": "world", "dimension": "overworld", "timeOfDay": 0},
            "self": {"position": {"x": 0, "y": 64, "z": 0}, "health": 20, "food": 20},
            "inventory": {"slots": []},
            "trackedPlayers": [],
        },
        "activity": None,
        "recentEvents": [],
        "memories": [],
        "availableSkills": ["collect_wood"],
    }


class DecideTest(unittest.TestCase):
    def test_decide_returns_validated_decision_and_does_not_leak_api_key(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "sk-test-secret", "model": "small-model"}
        captured_request = {}

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            captured_request["authorization"] = request.get_header("Authorization")
            body = json.dumps(
                {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "protocol": "mineintent.companion-decision.v1",
                                        "speech": "走吧。",
                                        "attention": {"kind": "player", "target": "Alex"},
                                        "activity": {"operation": "start_wood_collection", "summary": "一起收集木材"},
                                        "intent": {"kind": "collect", "summary": "找附近的树"},
                                        "action": {"skill": "collect_wood", "args": {"count": 4, "maxDistance": 32}, "purpose": "参与共同收集"},
                                        "memory": None,
                                    },
                                    ensure_ascii=False,
                                )
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 8},
                }
            ).encode("utf-8")
            return FakeResponse(body)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = server.decide(config, _context())

        self.assertEqual(result["decision"]["action"]["skill"], "collect_wood")
        self.assertEqual(result["usage"]["outputTokens"], 8)
        self.assertEqual(captured_request["authorization"], "Bearer sk-test-secret")
        self.assertNotIn("sk-test-secret", json.dumps(result))

    def test_decide_rejects_non_json_content(self) -> None:
        config = {"base_url": "https://model.invalid/v1", "api_key": "key", "model": "small-model"}

        def fake_urlopen(request, timeout=None):  # noqa: ARG001
            body = json.dumps({"choices": [{"message": {"content": "not json"}}]}).encode("utf-8")
            return FakeResponse(body)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            with self.assertRaises(RuntimeError):
                server.decide(config, _context())


class ValidateDecisionTest(unittest.TestCase):
    def _valid(self) -> dict:
        return {
            "protocol": "mineintent.companion-decision.v1",
            "speech": None,
            "attention": {"kind": "environment", "target": None},
            "activity": {"operation": "keep", "summary": "等待玩家一起游玩"},
            "intent": {"kind": "observe", "summary": "留意玩家和周围环境"},
            "action": None,
            "memory": None,
        }

    def test_accepts_minimal_valid_decision(self) -> None:
        validate_decision(self._valid())

    def test_applies_action_arg_defaults(self) -> None:
        decision = self._valid()
        decision["action"] = {"skill": "follow_player", "args": {}, "purpose": "跟随玩家"}
        result = validate_decision(decision)
        self.assertEqual(result["action"]["args"]["range"], 3)

    def test_rejects_unknown_top_level_key(self) -> None:
        decision = self._valid()
        decision["extra"] = True
        with self.assertRaises(DecisionValidationError):
            validate_decision(decision)

    def test_rejects_out_of_range_activity_operation(self) -> None:
        decision = self._valid()
        decision["activity"]["operation"] = "not_a_real_operation"
        with self.assertRaises(DecisionValidationError):
            validate_decision(decision)

    def test_rejects_missing_required_action_arg(self) -> None:
        decision = self._valid()
        decision["action"] = {"skill": "collect_wood", "args": {}, "purpose": "采集"}
        with self.assertRaises(DecisionValidationError):
            validate_decision(decision)


if __name__ == "__main__":
    unittest.main()
