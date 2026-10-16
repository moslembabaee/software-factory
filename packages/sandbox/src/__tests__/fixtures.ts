import { randomUUID } from "node:crypto";
import type { Execution } from "@software-factory/factory-core";

export const image = `node@sha256:${"a".repeat(64)}`;
export function execution(): Execution {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    workId: randomUUID(),
    parentExecutionId: null,
    state: "running",
    version: 1,
    budgetCapUsd: 10,
    reservedUsd: 0,
    spentUsd: 0,
    createdAt: new Date().toISOString(),
  };
}
