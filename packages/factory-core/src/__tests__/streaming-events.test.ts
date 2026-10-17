import { describe, expect, it } from "vitest";
import {
  StreamingEventSchema,
  TaskTransitionEventDataSchema,
  ConsoleLogEventDataSchema,
  RoadmapSyncEventDataSchema,
  type StreamingEvent,
} from "../build.js";

describe("Streaming event schemas", () => {
  it("validates a task transition event", () => {
    const rawData = {
      task_id: "T-ISSUE-30",
      status: "in_progress",
      previous_status: "approved",
      commit_sha: "abcdef123456",
      pr_ref: "42",
      github_issue_number: 30,
      timestamp: "2026-10-17T00:00:00Z",
    };
    const parsedData = TaskTransitionEventDataSchema.parse(rawData);
    expect(parsedData.task_id).toBe("T-ISSUE-30");
    expect(parsedData.status).toBe("in_progress");

    const event: StreamingEvent = {
      id: "11111111-2222-3333-4444-555555555555",
      type: "task_transition",
      task_id: "T-ISSUE-30",
      timestamp: "2026-10-17T00:00:00Z",
      data: parsedData,
    };
    const parsedEvent = StreamingEventSchema.parse(event);
    expect(parsedEvent.type).toBe("task_transition");
    expect(parsedEvent.task_id).toBe("T-ISSUE-30");
  });

  it("validates an agent console log event", () => {
    const rawLog = {
      id: "log-1",
      task_id: "T-ISSUE-30",
      source: "orchestrator",
      message: "Dispatching T-ISSUE-30 to claude",
      timestamp: "2026-10-17T00:00:01Z",
    };
    const parsedLog = ConsoleLogEventDataSchema.parse(rawLog);
    expect(parsedLog.source).toBe("orchestrator");

    const event = {
      id: "22222222-3333-4444-5555-666666666666",
      type: "console_log",
      task_id: "T-ISSUE-30",
      timestamp: "2026-10-17T00:00:01Z",
      data: parsedLog,
    };
    const parsedEvent = StreamingEventSchema.parse(event);
    expect(parsedEvent.type).toBe("console_log");
  });

  it("validates a roadmap sync event", () => {
    const rawSync = {
      action: "task_approved",
      task_id: "T-ISSUE-30",
      details: { issue_number: 30 },
      timestamp: "2026-10-17T00:00:02Z",
    };
    const parsedSync = RoadmapSyncEventDataSchema.parse(rawSync);
    expect(parsedSync.action).toBe("task_approved");

    const event = {
      id: "33333333-4444-5555-6666-777777777777",
      type: "roadmap_sync",
      task_id: "T-ISSUE-30",
      timestamp: "2026-10-17T00:00:02Z",
      data: parsedSync,
    };
    const parsedEvent = StreamingEventSchema.parse(event);
    expect(parsedEvent.type).toBe("roadmap_sync");
  });

  it("rejects unknown event types", () => {
    expect(() =>
      StreamingEventSchema.parse({
        id: "4444",
        type: "unknown_event_type",
        timestamp: "2026-10-17T00:00:00Z",
        data: {},
      }),
    ).toThrow();
  });
});
