import { describe, it, expect } from "vitest";
describe("factory-core primitives", () => {
    it("WorkState uses correct variants", () => {
        const _open = "open";
        const _active = "active";
        const _blocked = "blocked";
        const _completed = "completed";
        const _cancelled = "cancelled";
        const _failed = "failed";
        expect(_open).toBe("open");
        expect(_active).toBe("active");
        expect(_blocked).toBe("blocked");
        expect(_completed).toBe("completed");
        expect(_cancelled).toBe("cancelled");
        expect(_failed).toBe("failed");
    });
    it("ActorKind uses correct variants", () => {
        const _human = "human";
        const _agent = "agent";
        const _system = "system";
        const _external = "external";
        expect(_human).toBe("human");
        expect(_agent).toBe("agent");
        expect(_system).toBe("system");
        expect(_external).toBe("external");
    });
    it("ExecutionState uses correct variants", () => {
        const _q = "queued";
        const _r = "running";
        const _c = "completed";
        expect(_q).toBe("queued");
        expect(_r).toBe("running");
        expect(_c).toBe("completed");
    });
});
