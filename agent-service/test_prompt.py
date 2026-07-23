import unittest

from prompt import d40_model_context, d40_system_prompt, regular_model_context, regular_system_prompt


class ModelContextTest(unittest.TestCase):
    def test_preserves_root_binding_but_removes_world_refs_from_observations(self) -> None:
        context = {
            "protocol": "mineintent.context.v2",
            "ref": {"runId": "run-1", "worldId": "world-1"},
            "fragments": [
                {
                    "id": "old-product-constraints",
                    "section": "product_constraints",
                    "content": {"invariants": ["select a target with its issued opaque ref"]},
                },
                {
                    "id": "old-capabilities",
                    "section": "capabilities",
                    "content": {"invariants": ["Behavior planning may use only grounded referents"]},
                },
                {
                    "id": "observation-1",
                    "section": "observations",
                    "source": {"trust": "verified_observation", "ids": ["read-1"]},
                    "content": {
                        "protocol": "mineintent.information-read.v1",
                        "values": {
                            "visibleEntities": [{"ref": "entity-secret", "type": "sheep"}],
                            "lookedAtBlock": {"ref": "block-secret", "name": "grass_block"},
                            "visibleBlocks": {
                                "blocks": [{"ref": "visible-block-secret", "name": "stone", "relativePosition": [1.5, 0, 3.5]}],
                                "truncated": False,
                            },
                        },
                    },
                }
            ],
        }
        self.assertIs(regular_model_context(context), context)
        visible = d40_model_context(context)
        self.assertEqual(visible["ref"], context["ref"])
        self.assertEqual([item["section"] for item in visible["fragments"]], ["observations"])
        self.assertEqual(visible["fragments"][0]["content"]["values"]["visibleEntities"], [{"type": "sheep"}])
        self.assertEqual(visible["fragments"][0]["content"]["values"]["lookedAtBlock"], {"name": "grass_block"})
        self.assertEqual(
            visible["fragments"][0]["content"]["values"]["visibleBlocks"]["blocks"],
            [["stone", 1.5, 0, 3.5]],
        )
        self.assertEqual(context["fragments"][2]["content"]["values"]["visibleEntities"][0]["ref"], "entity-secret")


class SystemPromptTest(unittest.TestCase):
    def test_regular_prompt_keeps_the_formal_grounding_boundary(self) -> None:
        text = regular_system_prompt({"type": "object"})
        self.assertIn("Grounding", text)
        self.assertNotIn("look_relative", text)
        self.assertNotIn("move_input", text)

    def test_describes_the_d40_relative_tool_loop_and_final_v2_output(self) -> None:
        output_schema = {"type": "object", "properties": {"protocol": {"const": "mineintent.decision.v2"}}}
        text = d40_system_prompt(output_schema)
        self.assertIn("mineintent.decision.v2", text)
        self.assertIn("look_relative", text)
        self.assertIn("move_input", text)
        self.assertIn("每个子轮最多调用一个身体工具", text)
        self.assertIn("[block_name, right, up, forward]", text)
        self.assertIn("relativePosition 都严格表示 [right, up, forward]", text)
        self.assertIn("第一维为正表示右", text)
        self.assertIn("第二维为正表示上", text)
        self.assertIn("第三维为正表示前", text)
        self.assertIn("direction 的 left、right、forward、back 必须与该图例一致", text)
        self.assertIn("timing 必须是 now", text)
        self.assertNotIn("follow_player", text)
        self.assertNotIn("collect_wood", text)


if __name__ == "__main__":
    unittest.main()
