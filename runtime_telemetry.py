"""Accounting for the trusted repository runtime (not provider billing).

CLI token reports are preferred; character estimates are explicitly marked.
Rates are configurable USD per million tokens. Budgets gate dispatch/failover;
an individual provider invocation can overshoot its remaining budget.
"""

import json
import math
import re
from datetime import datetime, timezone

AGENT_RATES = {
    "claude": {"prompt": 3.00, "completion": 15.00},
    "claude-sonnet": {"prompt": 3.00, "completion": 15.00},
    "claude-opus": {"prompt": 15.00, "completion": 75.00},
    "claude-haiku": {"prompt": 0.80, "completion": 4.00},
    "sonnet": {"prompt": 3.00, "completion": 15.00},
    "opus": {"prompt": 15.00, "completion": 75.00},
    "haiku": {"prompt": 0.80, "completion": 4.00},
    "codex": {"prompt": 2.50, "completion": 10.00},
    "antigravity": {"prompt": 0.15, "completion": 0.60},
    "gemini": {"prompt": 0.15, "completion": 0.60},
}
FAILURES = ("quota", "agent", "verification", "budget_exceeded", "timeout", "runtime")
_UNSET = object()


def nonnegative(value, default=0):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else default


def token_usage(prompt: str, output: str) -> tuple[dict, bool]:
    # Decode complete JSON records and nested usage objects, even from a bounded
    # CLI tail. The last usage record is the final cumulative session report.
    candidates = []
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", output):
        try:
            value, _ = decoder.raw_decode(output, match.start())
        except ValueError:
            continue
        if not isinstance(value, dict):
            continue
        p = value.get("input_tokens", value.get("prompt_tokens"))
        c = value.get("output_tokens", value.get("completion_tokens"))
        if type(p) is int and p >= 0 and type(c) is int and c >= 0:
            candidates.append((p, c))
        elif "usage" in value and isinstance(value["usage"], dict):
            u = value["usage"]
            up = u.get("input_tokens", u.get("prompt_tokens"))
            uc = u.get("output_tokens", u.get("completion_tokens"))
            if type(up) is int and up >= 0 and type(uc) is int and uc >= 0:
                candidates.append((up, uc))
    if candidates:
        p, c = candidates[-1]
        return {"prompt": p, "completion": c, "total": p + c}, False
    match = re.search(r"(?i)tokens?:\s*(\d+)\s*(?:prompt|input)[,\s]+(\d+)\s*(?:completion|output)", output)
    if match:
        p, c = map(int, match.groups())
        return {"prompt": p, "completion": c, "total": p + c}, False
    match = re.search(r"(?i)tokens?:\s*(\d+)\s*(?:completion|output)[,\s]+(\d+)\s*(?:prompt|input)", output)
    if match:
        c, p = map(int, match.groups())
        return {"prompt": p, "completion": c, "total": p + c}, False
    match = re.search(r"(?i)(?:input|prompt)[_\s]tokens?:\s*(\d+)[,\s]+(?:output|completion)[_\s]tokens?:\s*(\d+)", output)
    if match:
        p, c = map(int, match.groups())
        return {"prompt": p, "completion": c, "total": p + c}, False
    match = re.search(r"(?i)(?:total[_\s]tokens|tokens? used)\s*:?\s*([\d,]+)", output)
    if match:
        total = int(match.group(1).replace(",", ""))
        p = min(total, (len(prompt) + 3) // 4)
        return {"prompt": p, "completion": total - p, "total": total}, True
    p, c = (len(prompt) + 3) // 4, (len(output) + 3) // 4
    return {"prompt": p, "completion": c, "total": p + c}, True


def token_cost(agent: str, tokens: dict, rates=None) -> float:
    rate = (rates or AGENT_RATES).get(agent, AGENT_RATES["claude"])
    return round((tokens["prompt"] * rate["prompt"] + tokens["completion"] * rate["completion"]) / 1_000_000, 6)


def budget_cap(task: dict, default=None):
    value = task.get("budget_cap_usd", default)
    if value is not None and nonnegative(value, None) is None:
        raise ValueError("budget_cap_usd must be finite and nonnegative")
    return value


def task_telemetry(task: dict, default_cap=_UNSET) -> dict:
    raw = task.get("telemetry") or {}
    attempts = task.get("attempts", [])
    count = len(attempts)
    # Keep historical spend even when a task is approved again (retry_count resets).
    tokens = raw.get("tokens") or {}
    prompt = int(nonnegative(tokens.get("prompt")))
    completion = int(nonnegative(tokens.get("completion")))
    spent = nonnegative(raw.get("cost_usd"))
    inherited_cap = (raw.get("budget") or {}).get("cap_usd") if default_cap is _UNSET else default_cap
    cap = budget_cap(task, inherited_cap)
    failures = {key: int(nonnegative(value)) for key, value in raw.get("failure_modes", {}).items() if key in FAILURES}
    return {
        "tokens": {"prompt": prompt, "completion": completion, "total": prompt + completion},
        "estimated_tokens": bool(raw.get("estimated_tokens", False)),
        "cost_usd": spent,
        "duration_seconds": nonnegative(raw.get("duration_seconds")),
        "agent_duration_seconds": nonnegative(raw.get("agent_duration_seconds")),
        "verification_duration_seconds": nonnegative(raw.get("verification_duration_seconds")),
        "attempt_count": count,
        "failed_attempts": sum(1 for attempt in attempts if attempt.get("failure")),
        "retry_rate": round(max(0, count - 1) / count, 4) if count else 0,
        "failure_modes": failures,
        "budget": {"cap_usd": cap, "spent_usd": spent, "exceeded": cap is not None and spent >= cap},
    }


def record_attempt(task: dict, attempt: dict, default_cap=None) -> None:
    telemetry = task_telemetry(task, default_cap)
    for key in ("prompt", "completion", "total"):
        telemetry["tokens"][key] += attempt["tokens"][key]
    telemetry["estimated_tokens"] |= attempt["estimated_tokens"]
    telemetry["cost_usd"] = round(telemetry["cost_usd"] + attempt["cost_usd"], 6)
    for key in ("duration_seconds", "agent_duration_seconds", "verification_duration_seconds"):
        telemetry[key] = round(telemetry[key] + attempt[key], 3)
    failure = attempt["failure"]
    if failure:
        telemetry["failure_modes"][failure] = telemetry["failure_modes"].get(failure, 0) + 1
    task.setdefault("attempts", []).append(attempt)
    task["telemetry"] = telemetry
    task["telemetry"] = task_telemetry(task, default_cap)


def active_attempt(task: dict, now=None):
    active = task.get("active_attempt")
    if not active or task.get("closed_at") or task.get("status") not in ("in_progress", "ready_for_verification"):
        return None
    try:
        start = datetime.fromisoformat(active["started_at"])
        elapsed = max(0, ((now or datetime.now(timezone.utc)) - start).total_seconds())
        return {"agent": active["agent"], "phase": active["phase"], "started_at": active["started_at"], "elapsed_seconds": round(elapsed, 3)}
    except (ValueError, TypeError, KeyError):
        return None


def build_metrics(tasks: list[dict]) -> dict:
    total_tokens = 0
    total_cost = total_duration = 0.0
    attempts = retries = 0
    caps = []
    exceeded = False
    failures = {}
    agents = {}
    for task in tasks:
        telemetry = task.get("telemetry") or task_telemetry(task)
        total_tokens += telemetry["tokens"]["total"]
        total_cost += telemetry["cost_usd"]
        total_duration += telemetry["duration_seconds"]
        count = telemetry["attempt_count"]
        attempts += count
        retries += max(0, count - 1)
        cap = telemetry["budget"]["cap_usd"]
        caps.append(cap)
        exceeded |= telemetry["budget"]["exceeded"]
        for mode, count in telemetry["failure_modes"].items():
            if mode in FAILURES:
                failures[mode] = failures.get(mode, 0) + count
        for index, attempt in enumerate(task.get("attempts", [])):
            agent = attempt["agent"]
            row = agents.setdefault(agent, {"agent": agent, "attempt_count": 0, "failed_attempts": 0,
                "total_tokens": 0, "total_cost_usd": 0.0, "avg_latency_seconds": 0.0,
                "retry_rate": 0.0, "failure_modes": {}})
            row["attempt_count"] += 1
            row["failed_attempts"] += bool(attempt.get("failure"))
            row["total_tokens"] += int(nonnegative((attempt.get("tokens") or {}).get("total")))
            row["total_cost_usd"] += nonnegative(attempt.get("cost_usd"))
            row["avg_latency_seconds"] += nonnegative(attempt.get("duration_seconds"))
            row["retry_rate"] += index > 0
            mode = attempt.get("failure")
            if mode in FAILURES:
                row["failure_modes"][mode] = row["failure_modes"].get(mode, 0) + 1
    for row in agents.values():
        row["total_cost_usd"] = round(row["total_cost_usd"], 6)
        row["avg_latency_seconds"] = round(row["avg_latency_seconds"] / row["attempt_count"], 3)
        row["retry_rate"] = round(row["retry_rate"] / row["attempt_count"], 4)
    return {"total_tokens": total_tokens, "total_cost_usd": round(total_cost, 6),
        "avg_latency_seconds": round(total_duration / attempts, 3) if attempts else 0,
        "attempt_count": attempts, "retry_rate": round(retries / attempts, 4) if attempts else 0,
        "failure_modes": failures, "agents": sorted(agents.values(), key=lambda row: row["agent"]),
        "budget": {"total_cap_usd": sum(caps) if caps and all(cap is not None for cap in caps) else None,
                   "total_spent_usd": round(total_cost, 6), "exceeded": exceeded}}


def enforce_budget(task: dict, proposed_cost: float = 0.0, default_cap=_UNSET) -> dict:
    telemetry = task_telemetry(task, default_cap)
    budget = telemetry["budget"]
    cap = budget["cap_usd"]
    spent = budget["spent_usd"]
    projected = round(spent + max(0.0, nonnegative(proposed_cost)), 6)
    exceeded = cap is not None and projected >= cap
    allowed = not exceeded
    return {
        "allowed": allowed,
        "cap_usd": cap,
        "spent_usd": spent,
        "projected_usd": projected,
        "exceeded": exceeded,
        "reason": "Budget limit exceeded" if exceeded else None,
    }
