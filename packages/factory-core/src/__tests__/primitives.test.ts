import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ActorKindSchema,
  ActorSchema,
  EventSchema,
  EventTypeSchema,
  ExecutionSchema,
  ExecutionStateSchema,
  ReferenceSchema,
  RelationSchema,
  WorkSchema,
  WorkStateSchema,
} from "../index.js";
import type {
  Actor,
  Event,
  EventType,
  Execution,
  ExecutionState,
  Reference,
  Relation,
  Work,
  WorkState,
} from "../index.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const otherId = "123e4567-e89b-42d3-a456-426614174001";
const timestamp = "2026-10-15T10:00:00.123456Z";
const identity = { id, tenantId: otherId };
const work = {
  ...identity,
  projectId: id,
  createdBy: otherId,
  objective: "Implement the six domain primitives",
  state: "open",
  version: 0,
  createdAt: timestamp,
} satisfies Work;
const actor = { ...identity, subject: "oidc|user-1" } satisfies Actor;
const execution = {
  ...identity,
  workId: id,
  parentExecutionId: null,
  state: "queued",
  version: 0,
  budgetCapUsd: 10,
  reservedUsd: 2,
  spentUsd: 3,
  createdAt: timestamp,
} satisfies Execution;
const reference = {
  ...identity,
  kind: "artifact",
  targetId: otherId,
} satisfies Reference;
const relation = {
  ...identity,
  fromRef: id,
  toRef: otherId,
  kind: "produced",
} satisfies Relation;
const event = {
  ...identity,
  executionId: id,
  sequence: 1,
  type: "execution.queued",
  payload: { nested: ["queued", 1, true, null, { status: "ok" }] },
  occurredAt: timestamp,
} satisfies Event;

const primitives = [
  { table: "works", schema: WorkSchema, value: work },
  { table: "actors", schema: ActorSchema, value: actor },
  { table: "executions", schema: ExecutionSchema, value: execution },
  { table: "references", schema: ReferenceSchema, value: reference },
  { table: "relations", schema: RelationSchema, value: relation },
  { table: "events", schema: EventSchema, value: event },
];
const storageSql = readFileSync(
  new URL("../../../../docs/45_STORAGE_SCHEMA.sql", import.meta.url),
  "utf8",
);

for (const { table, schema, value } of primitives) {
  describe(table, () => {
    it("validates a complete storage record without extra metadata", () => {
      expect(schema.parse(value)).toEqual(value);
    });

    it("covers every column in the normative storage table", () => {
      const definition = storageSql.match(
        new RegExp(`CREATE TABLE "?${table}"?\\((.*)\\);`),
      )?.[1];
      expect(definition).toBeDefined();
      const columns = definition
        ?.split(",")
        .map(
          (part) =>
            part
              .trim()
              .match(
                /^(\w+) (?:uuid|text|bigint|numeric|timestamptz|jsonb)\b/,
              )?.[1],
        )
        .filter((column) => column !== undefined);
      expect(columns?.length).toBeGreaterThan(0);
      const fields = Object.keys(schema.parse(value));
      for (const column of columns ?? []) {
        const camelCase = column.replace(/_([a-z])/g, (_, letter: string) =>
          letter.toUpperCase(),
        );
        expect(fields).toContain(camelCase);
      }
    });

    for (const field of Object.keys(value)) {
      it(`requires the storage field ${field}`, () => {
        const incomplete = Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== field),
        );
        expect(schema.safeParse(incomplete).success).toBe(false);
      });

      // JSON null is a valid JSONB value, distinct from SQL NULL.
      if (field !== "parentExecutionId" && field !== "payload") {
        it(`rejects null for ${field}`, () => {
          expect(schema.safeParse({ ...value, [field]: null }).success).toBe(
            false,
          );
        });
      }

      if (
        field === "id" ||
        field.endsWith("Id") ||
        ["createdBy", "fromRef", "toRef"].includes(field)
      ) {
        it(`rejects malformed UUIDs for ${field}`, () => {
          expect(
            schema.safeParse({ ...value, [field]: "invalid-id" }).success,
          ).toBe(false);
        });
      }
    }
  });
}

describe("state and event type unions", () => {
  it.each([
    "open",
    "active",
    "blocked",
    "waiting_approval",
    "paused",
    "completed",
    "cancelled",
    "failed",
  ])("accepts Work state %s", (state) => {
    expect(WorkSchema.safeParse({ ...work, state }).success).toBe(true);
  });

  it("matches every Execution state in the SQL CHECK constraint", () => {
    const states = storageSql
      .match(/CHECK\(state IN \(([^)]+)\)\)/)?.[1]
      ?.replaceAll("'", "")
      .split(",");
    expect(ExecutionStateSchema.options).toEqual(states);
    for (const state of states ?? []) {
      expect(ExecutionSchema.safeParse({ ...execution, state }).success).toBe(
        true,
      );
    }
  });

  it.each([
    "execution.queued",
    "execution.started",
    "agent.step.started",
    "agent.tool.requested",
    "agent.tool.completed",
    "approval.requested",
    "approval.decided",
    "agent.checkpoint.created",
    "execution.completed",
    "execution.failed",
    "execution.cancelled",
    "budget.exhausted",
  ])("accepts Event type %s", (type) => {
    expect(EventSchema.safeParse({ ...event, type }).success).toBe(true);
  });

  it.each(["unknown", "terminal", "created", "", "RUNNING"])(
    "rejects invalid states and event types: %s",
    (invalid) => {
      expect(WorkStateSchema.safeParse(invalid).success).toBe(false);
      expect(WorkSchema.safeParse({ ...work, state: invalid }).success).toBe(
        false,
      );
      expect(ExecutionStateSchema.safeParse(invalid).success).toBe(false);
      expect(
        ExecutionSchema.safeParse({ ...execution, state: invalid }).success,
      ).toBe(false);
      expect(EventTypeSchema.safeParse(invalid).success).toBe(false);
      expect(EventSchema.safeParse({ ...event, type: invalid }).success).toBe(
        false,
      );
    },
  );

  it("exports literal union types inferred from the enum schemas", () => {
    expectTypeOf(WorkStateSchema.parse("open")).toEqualTypeOf<WorkState>();
    expectTypeOf(
      ExecutionStateSchema.parse("queued"),
    ).toEqualTypeOf<ExecutionState>();
    expectTypeOf(
      EventTypeSchema.parse("execution.queued"),
    ).toEqualTypeOf<EventType>();
    expectTypeOf<WorkState>()
      .extract<"open" | "completed">()
      .toEqualTypeOf<"open" | "completed">();
    expectTypeOf<ExecutionState>()
      .extract<"running">()
      .toEqualTypeOf<"running">();
    expectTypeOf<EventType>()
      .extract<"budget.exhausted">()
      .toEqualTypeOf<"budget.exhausted">();
  });
});

describe("Execution budgets", () => {
  it.each(["budgetCapUsd", "reservedUsd", "spentUsd"])(
    "validates %s",
    (field) => {
      for (const invalid of [
        -1,
        NaN,
        Infinity,
        -Infinity,
        "5",
        0.0000001,
        1_000_000_000_000,
      ]) {
        expect(
          ExecutionSchema.safeParse({ ...execution, [field]: invalid }).success,
        ).toBe(false);
      }
    },
  );

  it.each([
    { budgetCapUsd: 0, reservedUsd: 0, spentUsd: 0 },
    { budgetCapUsd: 10, reservedUsd: 4, spentUsd: 6 },
    { budgetCapUsd: 0.3, reservedUsd: 0.1, spentUsd: 0.2 },
    {
      budgetCapUsd: 999_999_999_999,
      reservedUsd: 999_999_999_998.9999,
      spentUsd: 0.0001,
    },
    { budgetCapUsd: 0.000003, reservedUsd: 0.000001, spentUsd: 0.000002 },
  ])("accepts a budget within the cap: %j", (budget) => {
    expect(ExecutionSchema.safeParse({ ...execution, ...budget }).success).toBe(
      true,
    );
  });

  it.each([
    { budgetCapUsd: 10, reservedUsd: 6, spentUsd: 5 },
    { budgetCapUsd: 10, reservedUsd: 11, spentUsd: 0 },
    { budgetCapUsd: 10, reservedUsd: 0, spentUsd: 11 },
    { budgetCapUsd: 0.3, reservedUsd: 0.1, spentUsd: 0.200001 },
    {
      budgetCapUsd: 999_999_999_999,
      reservedUsd: 999_999_999_999,
      spentUsd: 0.000001,
    },
  ])("rejects a budget exceeding the cap: %j", (budget) => {
    const result = ExecutionSchema.safeParse({ ...execution, ...budget });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["budgetCapUsd"] }),
      );
    }
  });

  it("allows a nullable parent or a valid parent UUID", () => {
    expect(ExecutionSchema.parse(execution).parentExecutionId).toBeNull();
    expect(
      ExecutionSchema.parse({ ...execution, parentExecutionId: otherId })
        .parentExecutionId,
    ).toBe(otherId);
  });
});

describe("counters, timestamps, and payloads", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"])(
    "rejects invalid counters: %s",
    (invalid) => {
      expect(WorkSchema.safeParse({ ...work, version: invalid }).success).toBe(
        false,
      );
      expect(
        ExecutionSchema.safeParse({ ...execution, version: invalid }).success,
      ).toBe(false);
      expect(
        EventSchema.safeParse({ ...event, sequence: invalid }).success,
      ).toBe(false);
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "accepts safe counters: %s",
    (counter) => {
      expect(WorkSchema.safeParse({ ...work, version: counter }).success).toBe(
        true,
      );
      expect(
        ExecutionSchema.safeParse({ ...execution, version: counter }).success,
      ).toBe(true);
      expect(
        EventSchema.safeParse({ ...event, sequence: counter }).success,
      ).toBe(true);
    },
  );

  it.each([
    "not-a-date",
    "2026-02-30T10:00:00Z",
    "2026-10-15",
    "2026-10-15T10:00:00",
    0,
  ])("rejects invalid timestamps: %s", (invalid) => {
    expect(WorkSchema.safeParse({ ...work, createdAt: invalid }).success).toBe(
      false,
    );
    expect(
      ExecutionSchema.safeParse({ ...execution, createdAt: invalid }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ ...event, occurredAt: invalid }).success,
    ).toBe(false);
  });

  it("accepts timestamptz offsets", () => {
    expect(
      EventSchema.safeParse({
        ...event,
        occurredAt: "2026-10-15T13:30:00+03:30",
      }).success,
    ).toBe(true);
  });

  it.each([null, true, 42, "message", [], {}])(
    "accepts JSONB payload %j",
    (payload) => {
      expect(EventSchema.safeParse({ ...event, payload }).success).toBe(true);
    },
  );

  it.each([
    undefined,
    () => 1,
    BigInt(1),
    NaN,
    Infinity,
    { nested: undefined },
    { nested: [() => 1] },
  ])("rejects non-JSON payload %#", (payload) => {
    expect(EventSchema.safeParse({ ...event, payload }).success).toBe(false);
  });

  it("validates optional actor metadata", () => {
    for (const kind of ActorKindSchema.options) {
      expect(
        ActorSchema.safeParse({
          ...actor,
          kind,
          tags: ["reviewer"],
          metadata: { enabled: true },
          createdAt: timestamp,
        }).success,
      ).toBe(true);
    }
    expect(ActorSchema.safeParse({ ...actor, kind: "invalid" }).success).toBe(
      false,
    );
    expect(ActorSchema.safeParse({ ...actor, tags: [42] }).success).toBe(false);
    expect(
      ActorSchema.safeParse({ ...actor, metadata: { invalid: undefined } })
        .success,
    ).toBe(false);
  });

  it("keeps reference and relation kinds extensible", () => {
    expect(
      ReferenceSchema.parse({ ...reference, kind: "custom-resource" }).kind,
    ).toBe("custom-resource");
    expect(
      RelationSchema.parse({ ...relation, kind: "custom-relation" }).kind,
    ).toBe("custom-relation");
    expect(ReferenceSchema.safeParse({ ...reference, kind: 1 }).success).toBe(
      false,
    );
    expect(RelationSchema.safeParse({ ...relation, kind: 1 }).success).toBe(
      false,
    );
    expect(ActorSchema.safeParse({ ...actor, subject: 1 }).success).toBe(false);
    expect(WorkSchema.safeParse({ ...work, objective: 1 }).success).toBe(false);
  });
});
