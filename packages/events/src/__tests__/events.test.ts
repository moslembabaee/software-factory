import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Event, EventType } from "@software-factory/factory-core";
import { EventBus, replayExecution } from "@software-factory/events";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const tenantId = randomUUID();
const executionId = randomUUID();
function stream(types: EventType[]): Event[] {
  return types.map((type, sequence) => ({
    id: randomUUID(),
    tenantId,
    executionId,
    sequence,
    type,
    payload: {},
    occurredAt: new Date().toISOString(),
  }));
}

describe("event delivery", () => {
  it("awaits matching and wildcard consumers, isolates payloads, and unsubscribes", async () => {
    const bus = new EventBus();
    const [event] = stream(["execution.queued"]);
    if (!event) throw new Error("Missing event");
    const calls: string[] = [];
    const stop = bus.subscribe("execution.queued", async (fact) => {
      await Promise.resolve();
      Object.assign(fact.payload as object, { changed: true });
      calls.push("specific");
    });
    bus.subscribe("*", (fact) => {
      expect(fact.payload).toEqual({});
      calls.push("all");
      return Promise.resolve();
    });
    const other = vi.fn();
    bus.subscribe("execution.failed", other);
    await bus.publish(event);
    expect(calls).toEqual(["specific", "all"]);
    expect(other).not.toHaveBeenCalled();
    stop();
    await bus.publish(event);
    expect(calls).toEqual(["specific", "all", "all"]);
  });

  it("propagates consumer failures so the outbox can retry", async () => {
    const bus = new EventBus();
    bus.subscribe("*", () => Promise.reject(new Error("offline")));
    await expect(
      bus.publish(required(stream(["execution.queued"])[0])),
    ).rejects.toThrow("offline");
  });
});

describe("execution history replay", () => {
  const types: EventType[] = [
    "execution.created",
    "queue.enqueued",
    "execution.dispatched",
    "execution.started",
    "execution.verifying",
    "execution.completed",
  ];
  it("reconstructs every lifecycle phase and deduplicates repeated deliveries", () => {
    const events = stream(types);
    expect(replayExecution([])).toBeNull();
    for (const [index, phase] of [
      "queued",
      "queued",
      "dispatched",
      "running",
      "verifying",
      "completed",
    ].entries()) {
      expect(replayExecution(events.slice(0, index + 1))).toMatchObject({
        tenantId,
        executionId,
        phase,
        sequence: index,
      });
    }
    expect(replayExecution([...events, ...events])).toEqual(
      replayExecution(events),
    );
  });

  it.each(["execution.failed", "queue.timed_out"] as const)(
    "reconstructs %s",
    (type) => {
      expect(replayExecution(stream([...types.slice(0, 4), type]))?.phase).toBe(
        type === "execution.failed" ? "failed" : "needs_reconciliation",
      );
    },
  );

  it("rejects completion without verification and mutation of terminal state", () => {
    expect(() =>
      replayExecution(stream([...types.slice(0, 4), "execution.completed"])),
    ).toThrow("transition");
    expect(() =>
      replayExecution(stream([...types, "execution.started"])),
    ).toThrow("transition");
  });

  it("rejects gaps, reordering, mixed tenants, mixed executions and conflicting duplicate IDs", () => {
    const events = stream(types);
    expect(() => replayExecution(events.slice(1))).toThrow("contiguous");
    expect(() =>
      replayExecution([required(events[0]), required(events[2])]),
    ).toThrow("contiguous");
    for (const change of [
      { tenantId: randomUUID() },
      { executionId: randomUUID() },
    ]) {
      expect(() =>
        replayExecution([
          required(events[0]),
          { ...required(events[1]), ...change },
        ]),
      ).toThrow("tenant scoped");
    }
    expect(() =>
      replayExecution([
        required(events[0]),
        { ...required(events[0]), payload: { altered: true } },
      ]),
    ).toThrow("reused");
  });
});
