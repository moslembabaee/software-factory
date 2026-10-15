import { describe, it, expect } from "vitest";
import type { ActorKind, ExecutionState, WorkState } from "../index.js";

describe("factory-core primitives", () => {
  it("WorkState uses correct variants", () => {
    const _open: WorkState = "open";
    const _active: WorkState = "active";
    const _blocked: WorkState = "blocked";
    const _completed: WorkState = "completed";
    const _cancelled: WorkState = "cancelled";
    const _failed: WorkState = "failed";
    expect(_open).toBe("open");
    expect(_active).toBe("active");
    expect(_blocked).toBe("blocked");
    expect(_completed).toBe("completed");
    expect(_cancelled).toBe("cancelled");
    expect(_failed).toBe("failed");
  });

  it("ActorKind uses correct variants", () => {
    const _human: ActorKind = "human";
    const _agent: ActorKind = "agent";
    const _system: ActorKind = "system";
    const _external: ActorKind = "external";
    expect(_human).toBe("human");
    expect(_agent).toBe("agent");
    expect(_system).toBe("system");
    expect(_external).toBe("external");
  });

  it("ExecutionState uses correct variants", () => {
    const _q: ExecutionState = "queued";
    const _r: ExecutionState = "running";
    const _c: ExecutionState = "completed";
    expect(_q).toBe("queued");
    expect(_r).toBe("running");
    expect(_c).toBe("completed");
  });
});
