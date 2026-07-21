import unittest

from prompt import model_context, system_prompt


class ModelContextTest(unittest.TestCase):
    def _context(self, observations=None) -> dict:
        return {
            "runId": "run-1",
            "trigger": {"type": "player_chat", "text": "你现在有多少血？", "eventId": "event-1"},
            "primaryPlayer": "Alex",
            "snapshot": {
                "world": {"worldId": "world", "dimension": "overworld", "timeOfDay": 1000},
                "trackedPlayers": [],
            },
            "activity": None,
            "recentEvents": [],
            "memories": [],
            "availableSkills": ["collect_wood"],
            "observations": observations,
        }

    def test_surfaces_passive_observations_for_the_model(self) -> None:
        observations = {
            "currentStatus": {"health": 14, "food": 18, "foodSaturation": 3, "oxygen": 20, "experienceLevel": 2, "statusEffects": []},
            "inventory": {"selectedHotbarSlot": 0, "slots": [{"slot": 9, "itemName": "oak_log", "count": 3}]},
            "sound": {"recentSounds": []},
            "viewport": {"lookedAtBlock": None, "nearbyTrackedEntities": []},
            "omissions": [],
        }
        result = model_context(self._context(observations))
        self.assertEqual(result["currentStatus"]["health"], 14)
        self.assertEqual(result["inventory"]["slots"][0]["itemName"], "oak_log")
        self.assertEqual(result["observationOmissions"], [])

    def test_missing_observations_do_not_raise(self) -> None:
        result = model_context(self._context(None))
        self.assertIsNone(result["currentStatus"])
        self.assertEqual(result["observationOmissions"], [])


class SystemPromptTest(unittest.TestCase):
    def test_instructs_the_model_to_answer_from_real_observations(self) -> None:
        text = system_prompt("你是可靠的朋友。")
        self.assertIn("currentStatus", text)
        self.assertIn("observationOmissions", text)


if __name__ == "__main__":
    unittest.main()
