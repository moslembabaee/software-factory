import { describe, expect, it } from "vitest";
import {
  formatSseEvent,
  parseSseChunk,
  encodeWebSocketFrame,
  decodeWebSocketFrame,
  createEventFilter,
  TaskTransitionEventSchema,
  AgentLogEventSchema,
  RoadmapSyncEventSchema,
  TelemetryStreamEventSchema,
  StreamEventSchema,
} from "../index.js";

describe("Streaming Bus Primitives and Utilities", () => {
  it("formats and parses SSE event chunks correctly", () => {
    const data = { status: "in_progress", task_id: "T-001" };
    const formatted = formatSseEvent("task_transition", data, "evt-123");

    expect(formatted).toBe(
      `event: task_transition\nid: evt-123\ndata: ${JSON.stringify(data)}\n\n`,
    );

    const parsed = parseSseChunk(formatted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      event: "task_transition",
      id: "evt-123",
      data,
    });
  });

  it("parses multi-event and multi-line SSE streams and ignores keepalive comments", () => {
    const raw = [
      ": keepalive",
      "",
      "event: agent_log",
      "id: log-1",
      'data: {"task_id":"T-001","message":"Compiling sources"}',
      "",
      ": keepalive",
      "",
      "event: task_transition",
      "id: trans-2",
      'data: {"task_id":"T-001","status":"verified"}',
      "",
    ].join("\n");

    const parsed = parseSseChunk(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.event).toBe("agent_log");
    expect(parsed[0]?.id).toBe("log-1");
    expect(parsed[0]?.data).toEqual({
      task_id: "T-001",
      message: "Compiling sources",
    });

    expect(parsed[1]?.event).toBe("task_transition");
    expect(parsed[1]?.id).toBe("trans-2");
    expect(parsed[1]?.data).toEqual({
      task_id: "T-001",
      status: "verified",
    });
  });

  it("encodes and decodes unmasked WebSocket frames across various payload sizes", () => {
    // Short payload (<= 125 bytes)
    const shortText = "Hello Streaming Event Bus!";
    const shortFrame = encodeWebSocketFrame(shortText);
    expect(shortFrame[0]).toBe(0x81);
    expect(decodeWebSocketFrame(shortFrame)?.payload).toBe(shortText);

    // Medium payload (126 .. 65535 bytes)
    const mediumText = "x".repeat(300);
    const mediumFrame = encodeWebSocketFrame(mediumText);
    expect(mediumFrame[0]).toBe(0x81);
    expect(mediumFrame[1]).toBe(126);
    expect(decodeWebSocketFrame(mediumFrame)?.payload).toBe(mediumText);
  });

  it("decodes masked client WebSocket frames", () => {
    // Simulated masked client frame
    const payload = Buffer.from("ping");
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const maskedPayload = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      maskedPayload[i] = payload[i]! ^ mask[i % 4]!;
    }
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      maskedPayload,
    ]);

    const decoded = decodeWebSocketFrame(frame);
    expect(decoded?.payload).toBe("ping");
    expect(decoded?.opcode).toBe(1);
  });

  it("filters events by taskId and eventType", () => {
    const filter = createEventFilter({
      taskIds: ["T-001", "T-002"],
      eventTypes: ["task_transition", "agent_log"],
    });

    expect(filter({ task_id: "T-001", event_type: "task_transition" })).toBe(
      true,
    );
    expect(filter({ task_id: "T-003", event_type: "task_transition" })).toBe(
      false,
    );
    expect(filter({ task_id: "T-001", event_type: "telemetry" })).toBe(false);
    expect(filter({ event_type: "task_transition" })).toBe(true);
  });

  it("validates streaming event schemas with zod", () => {
    const transition = TaskTransitionEventSchema.parse({
      id: "evt-1",
      task_id: "T-001",
      event_type: "task_transition",
      status: "in_progress",
      previous_status: "approved",
      commit_sha: "abcdef1234567890",
      timestamp: new Date().toISOString(),
    });
    expect(transition.status).toBe("in_progress");

    const log = AgentLogEventSchema.parse({
      id: "log-1",
      task_id: "T-001",
      event_type: "agent_log",
      source: "orchestrator",
      message: "Agent started running task",
      timestamp: new Date().toISOString(),
    });
    expect(log.source).toBe("orchestrator");

    const sync = RoadmapSyncEventSchema.parse({
      event_type: "roadmap_sync",
      action: "sync_to_github",
      synced_count: 5,
      issue_number: 30,
      timestamp: new Date().toISOString(),
    });
    expect(sync.synced_count).toBe(5);

    const telemetry = TelemetryStreamEventSchema.parse({
      task_id: "T-001",
      event_type: "telemetry",
      timestamp: new Date().toISOString(),
    });
    expect(telemetry.event_type).toBe("telemetry");

    expect(StreamEventSchema.safeParse(transition).success).toBe(true);
    expect(StreamEventSchema.safeParse(log).success).toBe(true);
    expect(StreamEventSchema.safeParse(sync).success).toBe(true);
  });
});
