import { z } from "zod";
import { BuildStatusSchema, TaskTelemetrySchema } from "./build.js";

export const StreamEventTypeSchema = z.enum([
  "task_transition",
  "agent_log",
  "roadmap_sync",
  "telemetry",
  "snapshot",
  "connected",
  "ping",
]);

export const TaskTransitionEventSchema = z.strictObject({
  id: z.string().optional(),
  task_id: z.string().min(1),
  event_type: z.literal("task_transition"),
  status: BuildStatusSchema,
  previous_status: BuildStatusSchema.nullable().optional(),
  commit_sha: z.string().nullable().optional(),
  pr_ref: z.union([z.string(), z.number()]).nullable().optional(),
  timestamp: z.string(),
  message: z.string().optional(),
  source: z.string().optional(),
});

export const AgentLogEventSchema = z.strictObject({
  id: z.string().optional(),
  task_id: z.string(),
  event_type: z.literal("agent_log"),
  source: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

export const RoadmapSyncEventSchema = z.strictObject({
  id: z.string().optional(),
  task_id: z.string().optional(),
  event_type: z.literal("roadmap_sync"),
  action: z.string(),
  synced_count: z.number().int().nonnegative().optional(),
  issue_number: z.number().int().nullable().optional(),
  timestamp: z.string(),
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(),
});

export const TelemetryStreamEventSchema = z.strictObject({
  id: z.string().optional(),
  task_id: z.string(),
  event_type: z.literal("telemetry"),
  telemetry: TaskTelemetrySchema.optional(),
  active_attempt: z.any().optional(),
  timestamp: z.string(),
  source: z.string().optional(),
});

export const ConnectionStreamEventSchema = z.strictObject({
  id: z.string().optional(),
  event_type: z.literal("connected").optional(),
  status: z.literal("connected"),
  timestamp: z.string(),
  filter_task_id: z.string().optional(),
});

export const StreamEventSchema = z.union([
  TaskTransitionEventSchema,
  AgentLogEventSchema,
  RoadmapSyncEventSchema,
  TelemetryStreamEventSchema,
  ConnectionStreamEventSchema,
]);

export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;
export type TaskTransitionEvent = z.infer<typeof TaskTransitionEventSchema>;
export type AgentLogEvent = z.infer<typeof AgentLogEventSchema>;
export type RoadmapSyncEvent = z.infer<typeof RoadmapSyncEventSchema>;
export type TelemetryStreamEvent = z.infer<typeof TelemetryStreamEventSchema>;
export type ConnectionStreamEvent = z.infer<typeof ConnectionStreamEventSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Format an event payload according to the W3C Server-Sent Events specification.
 */
export function formatSseEvent(
  event: string,
  data: unknown,
  id?: string,
): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const lines: string[] = [`event: ${event}`];
  if (id) {
    lines.push(`id: ${id}`);
  }
  for (const line of payload.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Parse raw SSE chunks into discrete event objects.
 */
export function parseSseChunk(chunk: string): Array<{
  event?: string;
  data: unknown;
  id?: string;
}> {
  const events: Array<{ event?: string; data: unknown; id?: string }> = [];
  const blocks = chunk.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(":")) {
      continue; // Skip comments/keepalives or empty blocks
    }

    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // Comment line
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).replace(/^\s/, "");

      if (field === "event") {
        event = value;
      } else if (field === "id") {
        id = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (dataLines.length > 0 || event) {
      const rawData = dataLines.join("\n");
      let parsedData: unknown = rawData;
      try {
        parsedData = JSON.parse(rawData);
      } catch {
        parsedData = rawData;
      }
      const item: { event?: string; data: unknown; id?: string } = {
        data: parsedData,
      };
      if (event !== undefined) {
        item.event = event;
      }
      if (id !== undefined) {
        item.id = id;
      }
      events.push(item);
    }
  }

  return events;
}

/**
 * Encode a message payload into an RFC 6455 unmasked WebSocket frame.
 */
export function encodeWebSocketFrame(data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = payload.length;

  let header: Buffer;
  if (length <= 125) {
    header = Buffer.from([0x81, length]);
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Decode an RFC 6455 WebSocket frame buffer into payload string and opcode.
 */
export function decodeWebSocketFrame(buffer: Buffer): {
  payload: string;
  opcode: number;
} | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0]!;
  const secondByte = buffer[1]!;
  const opcode = firstByte & 0x0f;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;

  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    payloadLength = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskingKey: Buffer | null = null;
  if (isMasked) {
    if (buffer.length < offset + 4) return null;
    maskingKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;
  const rawPayload = Buffer.from(buffer.subarray(offset, offset + payloadLength));

  if (isMasked && maskingKey) {
    for (let i = 0; i < rawPayload.length; i++) {
      rawPayload[i]! ^= maskingKey[i % 4]!;
    }
  }

  return { payload: rawPayload.toString("utf8"), opcode };
}

/**
 * Filter predicate generator for stream events.
 */
export function createEventFilter(filter: {
  taskIds?: string[];
  eventTypes?: string[];
}): (event: { task_id?: string; event_type?: string }) => boolean {
  const taskSet = filter.taskIds ? new Set(filter.taskIds) : null;
  const typeSet = filter.eventTypes ? new Set(filter.eventTypes) : null;

  return (event) => {
    if (taskSet && event.task_id && !taskSet.has(event.task_id)) {
      return false;
    }
    if (typeSet && event.event_type && !typeSet.has(event.event_type)) {
      return false;
    }
    return true;
  };
}
