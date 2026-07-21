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
        "玩家问生命值、饥饿、氧气、经验、药水效果、背包、脚下方块、准星指向、附近声音或附近实体时，"
        "直接用 currentStatus/inventory/sound/viewport 里的真实数值回答，不要编造；"
        "viewport.lookedAtBlock 是准星精确指向的方块（原版 block_interaction_range 概念），"
        "不是一片视野范围；为 null 是很常见、正常的情况（准星没对准任何实心方块），"
        "如实说“正前方没看到方块”即可，不要当成故障或编造一个方块。"
        "viewport.visibleBlocks.blocks 是正前方视野内经过遮挡判定后确实可见的方块列表，按距离由近到远排列；"
        "每一项是 [offsetX, offsetY, offsetZ, name] 四元组（不是键值对象），坐标是相对自身的整数偏移量"
        "（例如 offsetZ=-3 大致是前方3格），不是世界坐标，也没有单独的距离字段——需要的话自己用偏移量估算远近；"
        "回答时按偏移量描述相对位置，不要当成精确坐标；列表为空是正常的（比如正对着空地），"
        "truncated 为 true 时说明视野内还有更多方块没列出。"
        "字段缺失或在 observationOmissions 中出现时，如实说当前不知道，不要假装看到了。"
        "这些数据只反映站立不动时能得知的情况，不代表你能移动、点击或打开界面查看更多。"
        "字段固定为 protocol,speech,attention,activity,intent,action,memory；不要 Markdown。"
        "必须严格使用以下 JSON 结构；所有对象必须保持为对象，不能简写成字符串：\n" + _DECISION_JSON_TEMPLATE
    )


def model_context(context: dict) -> dict:
    snapshot = context["snapshot"]
    observations = context.get("observations") or {}
    return {
        "protocol": "mineintent.decision-context.v1",
        "runId": context["runId"],
        "trigger": context["trigger"],
        "primaryPlayer": context["primaryPlayer"],
        "world": {
            "worldId": snapshot["world"]["worldId"],
            "dimension": snapshot["world"]["dimension"],
            "timeOfDay": snapshot["world"].get("timeOfDay"),
        },
        "currentStatus": observations.get("currentStatus"),
        "inventory": observations.get("inventory"),
        "sound": observations.get("sound"),
        "viewport": observations.get("viewport"),
        "observationOmissions": observations.get("omissions", []),
        "trackedPlayers": snapshot["trackedPlayers"],
        "activity": context.get("activity") or None,
        "recentEvents": context["recentEvents"],
        "retrievedMemories": context["memories"],
        "availableSkills": context["availableSkills"],
    }
