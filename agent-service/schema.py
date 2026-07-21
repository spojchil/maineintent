"""Validates model decision output against the mineintent.companion-decision.v1 contract.

Mirrors src/models/contracts.ts companionDecisionSchema field-for-field so the two
implementations can be diffed directly when the contract changes.
"""
from __future__ import annotations

DECISION_PROTOCOL = "mineintent.companion-decision.v1"

_ACTIVITY_OPERATIONS = {"keep", "start_wood_collection", "pause", "resume", "complete", "abandon"}
_MEMORY_KINDS = {"episode", "place", "commitment", "player_preference"}

_ACTION_ARG_SPECS = {
    "follow_player": {"range": ("number", 2, 8, 3)},
    "collect_wood": {"count": ("int", 1, 16, None), "maxDistance": ("int", 8, 64, 32)},
    "return_to_anchor": {},
    "wait": {"durationSeconds": ("int", 1, 120, None)},
}


class DecisionValidationError(ValueError):
    pass


def _fail(field: str, message: str) -> None:
    raise DecisionValidationError(f"{field}: {message}")


def _require_object(value: object, field: str) -> dict:
    if not isinstance(value, dict):
        _fail(field, "must be an object")
    return value  # type: ignore[return-value]


def _require_keys(obj: dict, allowed: set[str], field: str) -> None:
    missing = allowed - obj.keys()
    if missing:
        _fail(field, f"missing keys {sorted(missing)}")
    extra = obj.keys() - allowed
    if extra:
        _fail(field, f"unexpected keys {sorted(extra)}")


def _string(value: object, *, min_len: int, max_len: int, trim: bool, field: str) -> str:
    if not isinstance(value, str):
        _fail(field, "must be a string")
    text = value.strip() if trim else value  # type: ignore[union-attr]
    if len(text) < min_len or len(text) > max_len:
        _fail(field, f"length must be between {min_len} and {max_len}")
    return text


def _nullable_string(value: object, *, min_len: int, max_len: int, trim: bool, field: str) -> str | None:
    if value is None:
        return None
    return _string(value, min_len=min_len, max_len=max_len, trim=trim, field=field)


def _enum(value: object, allowed: set[str], field: str) -> str:
    if value not in allowed:
        _fail(field, f"must be one of {sorted(allowed)}")
    return value  # type: ignore[return-value]


def _number(value: object, minimum: float, maximum: float, field: str, *, integer: bool) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(field, "must be a number")
    if integer and not float(value).is_integer():
        _fail(field, "must be an integer")
    if value < minimum or value > maximum:
        _fail(field, f"must be between {minimum} and {maximum}")
    return value  # type: ignore[return-value]


def _validate_attention(value: object) -> dict:
    obj = _require_object(value, "attention")
    _require_keys(obj, {"kind", "target"}, "attention")
    return {
        "kind": _string(obj["kind"], min_len=1, max_len=64, trim=False, field="attention.kind"),
        "target": _nullable_string(obj["target"], min_len=0, max_len=128, trim=False, field="attention.target"),
    }


def _validate_activity(value: object) -> dict:
    obj = _require_object(value, "activity")
    _require_keys(obj, {"operation", "summary"}, "activity")
    return {
        "operation": _enum(obj["operation"], _ACTIVITY_OPERATIONS, "activity.operation"),
        "summary": _string(obj["summary"], min_len=1, max_len=300, trim=True, field="activity.summary"),
    }


def _validate_intent(value: object) -> dict:
    obj = _require_object(value, "intent")
    _require_keys(obj, {"kind", "summary"}, "intent")
    return {
        "kind": _string(obj["kind"], min_len=1, max_len=64, trim=False, field="intent.kind"),
        "summary": _string(obj["summary"], min_len=1, max_len=300, trim=True, field="intent.summary"),
    }


def _validate_action(value: object) -> dict | None:
    if value is None:
        return None
    obj = _require_object(value, "action")
    _require_keys(obj, {"skill", "args", "purpose"}, "action")
    skill = obj["skill"]
    if skill not in _ACTION_ARG_SPECS:
        _fail("action.skill", f"must be one of {sorted(_ACTION_ARG_SPECS)}")
    spec = _ACTION_ARG_SPECS[skill]
    args_obj = _require_object(obj["args"], "action.args")
    extra = args_obj.keys() - spec.keys()
    if extra:
        _fail("action.args", f"unexpected keys {sorted(extra)}")
    args: dict = {}
    for name, (kind, minimum, maximum, default) in spec.items():
        if name in args_obj:
            raw = args_obj[name]
        elif default is not None:
            raw = default
        else:
            _fail(f"action.args.{name}", "is required")
        args[name] = _number(raw, minimum, maximum, f"action.args.{name}", integer=kind == "int")
    purpose = _string(obj["purpose"], min_len=1, max_len=200, trim=False, field="action.purpose")
    return {"skill": skill, "args": args, "purpose": purpose}


def _validate_memory(value: object) -> dict | None:
    if value is None:
        return None
    obj = _require_object(value, "memory")
    _require_keys(obj, {"kind", "summary"}, "memory")
    return {
        "kind": _enum(obj["kind"], _MEMORY_KINDS, "memory.kind"),
        "summary": _string(obj["summary"], min_len=1, max_len=1_000, trim=True, field="memory.summary"),
    }


def validate_decision(value: object) -> dict:
    obj = _require_object(value, "decision")
    _require_keys(obj, {"protocol", "speech", "attention", "activity", "intent", "action", "memory"}, "decision")
    if obj["protocol"] != DECISION_PROTOCOL:
        _fail("protocol", f"must equal {DECISION_PROTOCOL!r}")
    return {
        "protocol": DECISION_PROTOCOL,
        "speech": _nullable_string(obj["speech"], min_len=1, max_len=500, trim=True, field="speech"),
        "attention": _validate_attention(obj["attention"]),
        "activity": _validate_activity(obj["activity"]),
        "intent": _validate_intent(obj["intent"]),
        "action": _validate_action(obj["action"]),
        "memory": _validate_memory(obj["memory"]),
    }
