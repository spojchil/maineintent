"""Builds the system prompt and user message sent to the OpenAI-compatible model.

Mirrors src/models/openai-compatible.ts systemPrompt/decisionJsonTemplate/modelContext so
prompt behaviour does not change when the Node provider is swapped for this service.
"""
from __future__ import annotations

import json

_DECISION_JSON_TEMPLATE = json.dumps(
    {
        "protocol": "mineintent.companion-decision.v1",
        "speech": None,
        "attention": {"kind": "environment", "target": None},
        "activity": {"operation": "keep", "summary": "等待玩家一起游玩"},
        "intent": {"kind": "observe", "summary": "留意玩家和周围环境"},
        "action": None,
        "memory": None,
    },
    ensure_ascii=False,
    indent=2,
) + (
    "\n activity.operation 只能取一个值：keep、start_wood_collection、pause、resume、complete、abandon。"
    "speech、attention.target、action、memory 可以为 JSON null；不要输出带竖线的枚举说明字符串。\n"
    "action 非 null 时只能是以下之一：" + json.dumps(
        [
            {"skill": "follow_player", "args": {"range": 3}, "purpose": "行动目的"},
            {"skill": "collect_wood", "args": {"count": 4, "maxDistance": 32}, "purpose": "行动目的"},
            {"skill": "return_to_anchor", "args": {}, "purpose": "行动目的"},
            {"skill": "wait", "args": {"durationSeconds": 10}, "purpose": "行动目的"},
        ],
        ensure_ascii=False,
    ) + "\n"
    "memory 非 null 时必须是 {\"kind\":\"episode|place|commitment|player_preference\",\"summary\":\"有证据支持的记忆\"}。"
)


def system_prompt(profile_content: str) -> str:
    return (
        f"你是 Minecraft 世界里的 AI 同伴。以下是可编辑同伴档案：\n\n{profile_content}\n\n"
        "你必须只输出符合 mineintent.companion-decision.v1 的 JSON 对象。你与玩家共同游玩，不是任务机器人。"
        "语言要简短自然；语言承诺必须与 action 一致，不能虚报成功。没有必要行动时 action 为 null。"
        "start_wood_collection 会记录出发地点；“够了/回刚才那里”应 complete 并选择 return_to_anchor。"
        "只有真实聊天、动作结果或已有记忆支持时才提出 memory，否则为 null。明确暂停优先。"
        "字段固定为 protocol,speech,attention,activity,intent,action,memory；不要 Markdown。"
        "必须严格使用以下 JSON 结构；所有对象必须保持为对象，不能简写成字符串：\n" + _DECISION_JSON_TEMPLATE
    )


def model_context(context: dict) -> dict:
    snapshot = context["snapshot"]
    return {
        "protocol": "mineintent.decision-context.v1",
        "runId": context["runId"],
        "trigger": context["trigger"],
        "primaryPlayer": context["primaryPlayer"],
        "world": {
            "worldId": snapshot["world"]["worldId"],
            "dimension": snapshot["world"]["dimension"],
            "timeOfDay": snapshot["world"]["timeOfDay"],
        },
        "self": {
            "position": snapshot["self"]["position"],
            "health": snapshot["self"]["health"],
            "food": snapshot["self"]["food"],
            "inventory": snapshot["inventory"]["slots"],
        },
        "trackedPlayers": snapshot["trackedPlayers"],
        "activity": context.get("activity") or None,
        "recentEvents": context["recentEvents"],
        "retrievedMemories": context["memories"],
        "availableSkills": context["availableSkills"],
    }
