import unittest

from prompt import model_context, system_prompt


class ModelContextTest(unittest.TestCase):
    def test_preserves_the_signed_v2_context_and_provenance(self) -> None:
        context = {
            "protocol": "mineintent.context.v2",
            "ref": {"runId": "run-1"},
            "fragments": [
                {
                    "id": "observation-1",
                    "source": {"trust": "verified_observation", "ids": ["read-1"]},
                    "content": {"protocol": "mineintent.information-read.v1", "values": {"health": 14}},
                }
            ],
        }
        self.assertEqual(model_context(context), context)


class SystemPromptTest(unittest.TestCase):
    def test_describes_v2_effects_without_exposing_a_skill_catalog(self) -> None:
        output_schema = {"type": "object", "properties": {"protocol": {"const": "mineintent.decision.v2"}}}
        text = system_prompt(output_schema)
        self.assertIn("mineintent.decision.v2", text)
        self.assertIn("Grounding", text)
        self.assertNotIn("follow_player", text)
        self.assertNotIn("collect_wood", text)


if __name__ == "__main__":
    unittest.main()
