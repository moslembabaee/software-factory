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
    "codex": {"prompt": 2.50, "completion": 10.00},
    "antigravity": {"prompt": 0.15, "completion": 0.60},
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
        if (type(p) is int and p >= 0 and type(c) is int and c >= 0):
            candidates.append((p, c))
    if candidates:
        p, c = candidates[-1]
        return {"prompt": p, "completion": c, "total": p + c}, False
    match = re.search(r"(?i)tokens?:\s*(\d+)\s*(?:prompt|input)[,\s]+(\d+)\s*(?:completion|output)", output)
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


def token_cost_breakdown(agent: str, tokens: dict, rates=None) -> dict:
    rate = (rates or AGENT_RATES).get(agent, AGENT_RATES["claude"])
    prompt = tokens.get("prompt", 0)
    completion = tokens.get("completion", 0)
    prompt_cost = round((prompt * rate["prompt"]) / 1_000_000, 6)
    completion_cost = round((completion * rate["completion"]) / 1_000_000, 6)
    total_cost = round((prompt * rate["prompt"] + completion * rate["completion"]) / 1_000_000, 6)
    return {
        "prompt_cost_usd": prompt_cost,
        "completion_cost_usd": completion_cost,
        "total_cost_usd": total_cost,
    }


def budget_cap(task: dict, default=None):
    value = task.get("budget_cap_usd", default)
    if value is not None and nonnegative(value, None) is None:
        raise ValueError("budget_cap_usd must be finite and nonnegative")
    return value


def cost_parts(agent: str, tokens: dict, cost: float, prompt_cost=None, completion_cost=None) -> dict:
    """Preserve recorded/custom-rate spend when migrating older attempts."""
    cost = round(nonnegative(cost), 6)
    if prompt_cost is None or completion_cost is None:
        weights = token_cost_breakdown(agent, tokens)
        total = weights["total_cost_usd"]
        prompt_cost = cost * weights["prompt_cost_usd"] / total if total else 0
    prompt_cost = round(min(cost, nonnegative(prompt_cost)), 6)
    return {"prompt_cost_usd": prompt_cost, "completion_cost_usd": round(cost - prompt_cost, 6)}


def reported_model(output: str) -> str:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", output):
        try:
            value, _ = decoder.raw_decode(output, match.start())
        except ValueError:
            continue
        model = value.get("model") if isinstance(value, dict) else None
        if isinstance(model, str) and 0 < len(model) <= 200:
            return model
    return "unspecified"


def pending_attempt(task: dict, index: int) -> bool:
    attempt = task.get("attempts", [])[index]
    if attempt.get("failure"):
        return False
    if "finalized" in attempt:
        return attempt["finalized"] is False
    return (
        index == len(task["attempts"]) - 1
        and (task.get("active_attempt") or {}).get("phase") == "verification"
    )


def task_telemetry(task: dict, default_cap=_UNSET) -> dict:
    raw = task.get("telemetry") or {}
    attempts = task.get("attempts", [])
    count = len(attempts)
    tokens = raw.get("tokens") or {}
    prompt = int(nonnegative(tokens.get("prompt", sum(nonnegative((a.get("tokens") or {}).get("prompt")) for a in attempts))))
    completion = int(nonnegative(tokens.get("completion", sum(nonnegative((a.get("tokens") or {}).get("completion")) for a in attempts))))
    spent = round(nonnegative(raw.get("cost_usd", sum(nonnegative(a.get("cost_usd")) for a in attempts))), 6)
    inherited_cap = (raw.get("budget") or {}).get("cap_usd") if default_cap is _UNSET else default_cap
    cap = budget_cap(task, inherited_cap)
    failures = {key: int(nonnegative(value)) for key, value in raw.get("failure_modes", {}).items() if key in FAILURES}
    if "failure_modes" not in raw:
        for attempt in attempts:
            mode = attempt.get("failure")
            if mode in FAILURES:
                failures[mode] = failures.get(mode, 0) + 1
    parts = [cost_parts(a.get("agent", "claude"), a.get("tokens") or {}, a.get("cost_usd", 0),
                        a.get("prompt_cost_usd"), a.get("completion_cost_usd")) for a in attempts]
    prompt_cost = raw.get("prompt_cost_usd")
    if prompt_cost is None and attempts:
        prompt_cost = sum(part["prompt_cost_usd"] for part in parts)
    split = cost_parts(task.get("assigned_agent") or "claude", {"prompt": prompt, "completion": completion},
                       spent, prompt_cost, raw.get("completion_cost_usd", 0) if prompt_cost is not None else None)
    failed = sum(bool(a.get("failure")) for a in attempts)
    pending = sum(pending_attempt(task, index) for index in range(count))
    successful = count - failed - pending
    resolved = failed + successful
    durations = {key: nonnegative(raw.get(key, sum(nonnegative(a.get(key)) for a in attempts)))
                 for key in ("duration_seconds", "agent_duration_seconds", "verification_duration_seconds")}
    return {
        "tokens": {"prompt": prompt, "completion": completion, "total": prompt + completion},
        "estimated_tokens": bool(raw.get("estimated_tokens", any(a.get("estimated_tokens") for a in attempts))),
        "cost_usd": spent, **split, **durations,
        "avg_agent_latency_seconds": round(durations["agent_duration_seconds"] / count, 3) if count else 0,
        "avg_verification_latency_seconds": round(durations["verification_duration_seconds"] / count, 3) if count else 0,
        "attempt_count": count, "failed_attempts": failed, "successful_attempts": successful,
        "pending_attempts": pending,
        "success_rate": round(successful / resolved, 4) if resolved else 0,
        "failure_rate": round(failed / resolved, 4) if resolved else 0,
        "retry_rate": round(max(0, count - 1) / count, 4) if count else 0,
        "failure_modes": failures,
        "budget": {"cap_usd": cap, "spent_usd": spent, "exceeded": cap is not None and spent >= cap},
    }


def record_attempt(task: dict, attempt: dict, default_cap=None) -> None:
    stats = task_telemetry(task, default_cap)
    split = cost_parts(attempt["agent"], attempt["tokens"], attempt["cost_usd"],
                       attempt.get("prompt_cost_usd"), attempt.get("completion_cost_usd"))
    attempt.update(split)
    for key in ("prompt", "completion", "total"):
        stats["tokens"][key] += attempt["tokens"][key]
    stats["estimated_tokens"] |= attempt["estimated_tokens"]
    for key in ("cost_usd", "prompt_cost_usd", "completion_cost_usd"):
        stats[key] = round(stats[key] + attempt[key], 6)
    for key in ("duration_seconds", "agent_duration_seconds", "verification_duration_seconds"):
        stats[key] = round(stats[key] + attempt[key], 3)
    failure = attempt["failure"]
    if failure:
        stats["failure_modes"][failure] = stats["failure_modes"].get(failure, 0) + 1
    task.setdefault("attempts", []).append(attempt)
    task["telemetry"] = stats
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


def latency_summary(values: list[float]) -> dict:
    """Nearest-rank percentiles over recorded provider invocation latencies."""
    values = sorted(values)
    return {f"{name}_latency_seconds": round(value, 3) for name, value in {
        "min": values[0] if values else 0,
        "max": values[-1] if values else 0,
        "p50": values[math.ceil(len(values) * .50) - 1] if values else 0,
        "p95": values[math.ceil(len(values) * .95) - 1] if values else 0,
    }.items()}


def attempt_metrics(entries: list[tuple[dict, int]]) -> dict:
    rows = [task["attempts"][index] for task, index in entries]
    count = len(rows)
    failed = sum(bool(row.get("failure")) for row in rows)
    pending = sum(pending_attempt(task, index) for task, index in entries)
    successful = count - failed - pending
    resolved = failed + successful
    failures = {}
    for row in rows:
        mode = row.get("failure")
        if mode in FAILURES:
            failures[mode] = failures.get(mode, 0) + 1
    parts = [cost_parts(row["agent"], row.get("tokens") or {}, row.get("cost_usd", 0),
                        row.get("prompt_cost_usd"), row.get("completion_cost_usd")) for row in rows]
    prompt = sum(int(nonnegative((row.get("tokens") or {}).get("prompt"))) for row in rows)
    completion = sum(int(nonnegative((row.get("tokens") or {}).get("completion"))) for row in rows)
    agent_latencies = [nonnegative(row.get("agent_duration_seconds", row.get("duration_seconds"))) for row in rows]
    return {
        "attempt_count": count, "failed_attempts": failed, "successful_attempts": successful,
        "pending_attempts": pending,
        "success_rate": round(successful / resolved, 4) if resolved else 0,
        "failure_rate": round(failed / resolved, 4) if resolved else 0,
        "total_tokens": prompt + completion, "prompt_tokens": prompt, "completion_tokens": completion,
        "total_cost_usd": round(sum(nonnegative(row.get("cost_usd")) for row in rows), 6),
        **{key: round(sum(part[key] for part in parts), 6) for key in ("prompt_cost_usd", "completion_cost_usd")},
        "avg_latency_seconds": round(sum(nonnegative(row.get("duration_seconds")) for row in rows) / count, 3) if count else 0,
        "avg_agent_latency_seconds": round(sum(agent_latencies) / count, 3) if count else 0,
        "avg_verification_latency_seconds": round(sum(nonnegative(row.get("verification_duration_seconds")) for row in rows) / count, 3) if count else 0,
        **latency_summary(agent_latencies),
        "retry_rate": round(sum(index > 0 for _, index in entries) / count, 4) if count else 0,
        "failure_modes": failures,
    }


def build_metrics(tasks: list[dict]) -> dict:
    entries = [(task, index) for task in tasks for index in range(len(task.get("attempts", [])))]
    stats = attempt_metrics(entries)
    agents, models = {}, {}
    for task, index in entries:
        attempt = task["attempts"][index]
        agent = attempt["agent"]
        model = attempt.get("model") or "unspecified"
        agents.setdefault(agent, []).append((task, index))
        models.setdefault((agent, model), []).append((task, index))
    telemetry = [task_telemetry(task) for task in tasks]
    # Task totals retain historical spend even if old attempt details were pruned.
    for target, source in (("total_cost_usd", "cost_usd"), ("prompt_cost_usd", "prompt_cost_usd"),
                           ("completion_cost_usd", "completion_cost_usd")):
        stats[target] = round(sum(row[source] for row in telemetry), 6)
    for target, source in (("prompt_tokens", "prompt"), ("completion_tokens", "completion"), ("total_tokens", "total")):
        stats[target] = sum(row["tokens"][source] for row in telemetry)
    for key in ("duration_seconds", "agent_duration_seconds", "verification_duration_seconds"):
        stats[f"total_{key}"] = round(sum(row[key] for row in telemetry), 3)
    for target, source in (("avg_latency_seconds", "duration_seconds"),
                           ("avg_agent_latency_seconds", "agent_duration_seconds"),
                           ("avg_verification_latency_seconds", "verification_duration_seconds")):
        stats[target] = round(stats[f"total_{source}"] / len(entries), 3) if entries else 0
    failures = {}
    for row in telemetry:
        for mode, count in row["failure_modes"].items():
            failures[mode] = failures.get(mode, 0) + count
    stats["failure_modes"] = failures
    lifecycle = {}
    for task in tasks:
        status = "completed" if task.get("closed_at") else task.get("status", "pending")
        lifecycle[status] = lifecycle.get(status, 0) + 1
    caps = [row["budget"]["cap_usd"] for row in telemetry]
    return {
        **stats,
        "agents": [{"agent": agent, **attempt_metrics(agents[agent])} for agent in sorted(agents)],
        "models": [{"agent": agent, "model": model, **attempt_metrics(models[(agent, model)])}
                   for agent, model in sorted(models)],
        "budget": {"total_cap_usd": round(sum(caps), 6) if caps and all(cap is not None for cap in caps) else None,
                   "total_spent_usd": stats["total_cost_usd"],
                   "exceeded": any(row["budget"]["exceeded"] for row in telemetry)},
        "task_lifecycle_counts": lifecycle,
        "total_tasks_count": len(tasks),
        "completed_tasks_count": lifecycle.get("completed", 0),
        "active_tasks_count": sum(lifecycle.get(key, 0) for key in ("in_progress", "ready_for_verification")),
        "pending_tasks_count": sum(lifecycle.get(key, 0) for key in ("pending", "waiting_approval", "pending_approval", "assigned", "approved")),
        "failed_tasks_count": sum(lifecycle.get(key, 0) for key in ("failed", "escalated")),
        "completion_rate": round(lifecycle.get("completed", 0) / len(tasks), 4) if tasks else 0,
        "active_agent_count": sum(bool(task.get("active_attempt")) and not task.get("closed_at")
                                  and task.get("status") in ("in_progress", "ready_for_verification") for task in tasks),
    }
