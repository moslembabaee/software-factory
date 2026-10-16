import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { TenantIdentity } from "@software-factory/storage";
import {
  BuildSnapshotSchema,
  type BuildSnapshot,
  type BuildBudgetUpdate,
} from "@software-factory/factory-core";
import { repositoryRoadmap } from "./ask-roadmap.js";
import { ApiError } from "./errors.js";

export interface BuildRoadmap {
  setBudget(
    identity: TenantIdentity,
    projectId: string,
    taskId: string,
    update: BuildBudgetUpdate,
  ): Promise<BuildSnapshot>;
  snapshot(identity: TenantIdentity, projectId: string): Promise<BuildSnapshot>;
  approve(
    identity: TenantIdentity,
    projectId: string,
    taskId: string,
    revision: string,
  ): Promise<BuildSnapshot>;
}

export class FileBuildRoadmap implements BuildRoadmap {
  constructor(private readonly path = repositoryRoadmap()) {}

  private async run(
    operation: string,
    identity: TenantIdentity,
    projectId: string,
    taskId?: string,
    revision?: string,
    budget_cap_usd?: number | null,
  ): Promise<BuildSnapshot> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "python3",
        [join(dirname(repositoryRoadmap()), "build_dashboard.py"), this.path],
        { timeout: 10_000, maxBuffer: 4_000_000 },
        (error, stdout) => {
          if (error)
            reject(new Error("Build roadmap unavailable", { cause: error }));
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", reject);
      child.stdin?.end(
        JSON.stringify({
          operation,
          identity,
          projectId,
          taskId,
          revision,
          budget_cap_usd,
        }),
      );
    });
    const result: unknown = JSON.parse(output);
    if (result && typeof result === "object" && "error" in result) {
      if (result.error === 404)
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      if (result.error === 409)
        throw new ApiError(
          409,
          "CONFLICT",
          "Task changed; refresh before updating",
        );
    }
    return BuildSnapshotSchema.parse(result);
  }

  snapshot(
    identity: TenantIdentity,
    projectId: string,
  ): Promise<BuildSnapshot> {
    return this.run("snapshot", identity, projectId);
  }
  setBudget(
    identity: TenantIdentity,
    projectId: string,
    taskId: string,
    update: BuildBudgetUpdate,
  ): Promise<BuildSnapshot> {
    return this.run(
      "budget",
      identity,
      projectId,
      taskId,
      update.revision,
      update.budget_cap_usd,
    );
  }
  approve(
    identity: TenantIdentity,
    projectId: string,
    taskId: string,
    revision: string,
  ): Promise<BuildSnapshot> {
    return this.run("approve", identity, projectId, taskId, revision);
  }
}
