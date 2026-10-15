import { EventSchema, ExecutionSchema } from "@software-factory/factory-core";
import type { Event, Execution } from "@software-factory/factory-core";
import type { TenantDatabase, TenantIdentity } from "./database.js";
import { appendExecutionEvent } from "./append-event.js";

export class ExecutionConflictError extends Error {
  override readonly name = "ExecutionConflictError";
}

interface ExecutionRow {
  id: string;
  tenant_id: string;
  work_id: string;
  parent_execution_id: string | null;
  state: string;
  version: string;
  budget_cap_usd: string;
  reserved_usd: string;
  spent_usd: string;
  created_at: Date;
}

export interface VerificationDecision {
  readonly executionId: string;
  readonly expectedVersion: number;
  readonly causeEventId: string;
  readonly evidenceArtifactId: string;
  readonly outcome: "completed" | "failed";
}

/** Trusted verifier boundary; process exit alone never authorizes completion. */
export class PostgresExecutionHistory {
  constructor(private readonly database: TenantDatabase) {}

  async get(
    identity: TenantIdentity,
    executionId: string,
  ): Promise<Execution | null> {
    return this.database.withTenant(identity, async (client) => {
      const result = await client.query<ExecutionRow>(
        "SELECT * FROM executions WHERE tenant_id = $1 AND id = $2",
        [identity.tenantId, executionId],
      );
      const row = result.rows[0];
      return row
        ? ExecutionSchema.parse({
            id: row.id,
            tenantId: row.tenant_id,
            workId: row.work_id,
            parentExecutionId: row.parent_execution_id,
            state: row.state,
            version: Number(row.version),
            budgetCapUsd: Number(row.budget_cap_usd),
            reservedUsd: Number(row.reserved_usd),
            spentUsd: Number(row.spent_usd),
            createdAt: row.created_at.toISOString(),
          })
        : null;
    });
  }

  async list(identity: TenantIdentity, executionId: string): Promise<Event[]> {
    return this.database.withTenant(identity, async (client) => {
      const result = await client.query<{
        id: string;
        tenant_id: string;
        execution_id: string;
        sequence: string;
        type: string;
        payload: unknown;
        occurred_at: Date;
      }>(
        "SELECT * FROM events WHERE tenant_id = $1 AND execution_id = $2 ORDER BY sequence",
        [identity.tenantId, executionId],
      );
      return result.rows.map((row) =>
        EventSchema.parse({
          id: row.id,
          tenantId: row.tenant_id,
          executionId: row.execution_id,
          sequence: Number(row.sequence),
          type: row.type,
          payload: row.payload,
          occurredAt: row.occurred_at.toISOString(),
        }),
      );
    });
  }

  async finishVerification(
    identity: TenantIdentity,
    decision: VerificationDecision,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(decision.expectedVersion) ||
      decision.expectedVersion < 0 ||
      !["completed", "failed"].includes(decision.outcome)
    )
      throw new TypeError("Invalid verification decision");
    await this.database.withTenant(identity, async (client) => {
      const selected = await client.query<{ state: string; version: string }>(
        "SELECT state, version FROM executions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [identity.tenantId, decision.executionId],
      );
      const current = selected.rows[0];
      if (
        !current ||
        current.state !== "verifying" ||
        Number(current.version) !== decision.expectedVersion
      ) {
        throw new ExecutionConflictError(
          "Execution is not at the expected verification version",
        );
      }
      const evidence = await client.query(
        `SELECT a.id FROM artifacts a JOIN events e ON e.tenant_id = a.tenant_id AND e.execution_id = a.execution_id
         WHERE a.tenant_id = $1 AND a.execution_id = $2 AND a.id = $3 AND e.id = $4 AND e.type = 'execution.verifying'`,
        [
          identity.tenantId,
          decision.executionId,
          decision.evidenceArtifactId,
          decision.causeEventId,
        ],
      );
      if (!evidence.rows.length)
        throw new ExecutionConflictError(
          "Verification requires persisted evidence and its causal event",
        );
      if (decision.outcome === "completed") {
        const approvals = await client.query<{
          decision: string;
          valid: boolean;
        }>(
          `SELECT decision, (consumed_at IS NOT NULL AND expires_at > clock_timestamp()) AS valid
           FROM approvals WHERE tenant_id = $1 AND execution_id = $2 FOR UPDATE`,
          [identity.tenantId, decision.executionId],
        );
        if (
          approvals.rows.some(
            (row) => row.decision !== "approved" || !row.valid,
          )
        ) {
          throw new ExecutionConflictError(
            "Required approvals are not valid and consumed",
          );
        }
      }
      await client.query(
        "UPDATE executions SET state = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $4",
        [
          identity.tenantId,
          decision.executionId,
          decision.outcome,
          decision.expectedVersion,
        ],
      );
      await appendExecutionEvent(
        client,
        identity,
        decision.executionId,
        `execution.${decision.outcome}`,
        {
          expected_version: decision.expectedVersion,
          cause_event_id: decision.causeEventId,
          evidence_artifact_id: decision.evidenceArtifactId,
        },
      );
    });
  }
}
