import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  canApproveTask,
  type BuildSnapshot,
  type BuildTask,
} from "@software-factory/factory-core";
import {
  BuildDashboard,
  BuildProgress,
  BuildTaskCard,
  BuildMetricsPanel,
} from "./BuildDashboard.js";
import { Workbench } from "./Workbench.js";
import { createBuildClient, type BuildEventSource } from "./build-client.js";

const task: BuildTask = {
  id: "T-1",
  title: "<script>Title</script>",
  description: "Task description",
  phase: "Build",
  status: "pending",
  revision: "a".repeat(64),
  github_issue_number: 42,
  closed_at: null,
  commit_sha: null,
  assigned_agent: "codex",
  retry_count: 0,
};
const snapshot: BuildSnapshot = {
  tasks: [task],
  current_task_id: null,
  logs: [],
};
class MockStream extends EventTarget implements BuildEventSource {
  close = vi.fn();
  readyState = 0;
  onerror: EventSource["onerror"] = null;
  send(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

describe("Build workbench", () => {
  it("renders costs, latency, failure charts and budget exhaustion accessibly", () => {
    const markup = renderToStaticMarkup(
      createElement(BuildMetricsPanel, {
        metrics: {
          total_tokens: 1200,
          total_cost_usd: 0.006,
          avg_latency_seconds: 2.5,
          attempt_count: 2,
          retry_rate: 0.5,
          failure_modes: { timeout: 1 },
          budget: {
            total_cap_usd: 0.005,
            total_spent_usd: 0.006,
            exceeded: true,
          },
          agents: [
            {
              agent: "codex",
              attempt_count: 2,
              failed_attempts: 1,
              total_tokens: 1200,
              total_cost_usd: 0.006,
              avg_latency_seconds: 2.5,
              retry_rate: 0.5,
              failure_modes: { timeout: 1 },
            },
          ],
        },
      }),
    );
    expect(markup).toContain("$0.006000");
    expect(markup).toContain("2.50s");
    expect(markup).toContain("50.0%");
    expect(markup).toContain('aria-label="timeout failures"');
    expect(markup).toContain("Agent performance");
    expect(markup).toContain("A task has reached its budget limit.");
    const card = renderToStaticMarkup(
      createElement(BuildTaskCard, {
        task: {
          ...task,
          status: "in_progress",
          budget_cap_usd: 0,
          active_attempt: {
            agent: "codex",
            phase: "agent",
            started_at: "2026-10-16T00:00:00Z",
            elapsed_seconds: 5,
          },
          telemetry: {
            tokens: { prompt: 1000, completion: 200, total: 1200 },
            cost_usd: 0.006,
            estimated_tokens: true,
            duration_seconds: 2.5,
            agent_duration_seconds: 2,
            verification_duration_seconds: 0.5,
            attempt_count: 2,
            failed_attempts: 1,
            retry_rate: 0.5,
            failure_modes: { timeout: 1 },
            budget: { cap_usd: 0, spent_usd: 0.006, exceeded: true },
          },
        },
        busy: false,
        onApprove: vi.fn(),
        onSetBudget: vi.fn(),
      }),
    );
    expect(card).toContain("(estimated)");
    expect(card).toContain("Budget limit reached");
    expect(card).toContain("Running codex: agent");
    expect(card).toContain('max="1" value="1"');
    expect(card).toContain("Save budget");
  });

  it("sends budget decisions with the task revision and supports removing the limit", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(snapshot))),
      );
    const client = createBuildClient(transport);
    for (const cap of [0, null, 0.005]) {
      await client.setBudget("project/one", "T/1", {
        revision: task.revision,
        budget_cap_usd: cap,
      });
      expect(transport).toHaveBeenLastCalledWith(
        "/api/v1/projects/project%2Fone/build/tasks/T%2F1/budget",
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revision: task.revision,
            budget_cap_usd: cap,
          }),
        },
      );
    }
  });

  it("renders accessible progress, task decisions and safely escaped issue context", () => {
    const markup = renderToStaticMarkup(
      createElement(BuildTaskCard, { task, busy: false, onApprove: vi.fn() }),
    );
    expect(markup).toContain("&lt;script&gt;Title&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("GitHub issue #42");
    expect(markup).toContain("Approve task");
    const progress = renderToStaticMarkup(
      createElement(BuildProgress, {
        snapshot: {
          ...snapshot,
          tasks: [{ ...task, status: "completed" }, task],
        },
      }),
    );
    expect(progress).toContain("1 of 2 tasks completed");
    expect(progress).toContain('max="2" value="1"');
  });

  it.each([
    "approved",
    "in_progress",
    "ready_for_verification",
    "verified",
    "completed",
    "cancelled",
  ] as const)("has no approval action for %s", (status) => {
    const next = { ...task, status };
    expect(canApproveTask(next)).toBe(false);
    const markup = renderToStaticMarkup(
      createElement(BuildTaskCard, {
        task: next,
        busy: false,
        onApprove: vi.fn(),
      }),
    );
    expect(markup).not.toContain("<button");
  });

  it("offers an explicit retry for failure and hides approval on closed issues", () => {
    const failed = { ...task, status: "failed" as const };
    expect(canApproveTask(failed)).toBe(true);
    expect(
      renderToStaticMarkup(
        createElement(BuildTaskCard, {
          task: failed,
          busy: false,
          onApprove: vi.fn(),
        }),
      ),
    ).toContain("Approve retry");
    expect(
      canApproveTask({ ...failed, closed_at: "2026-10-15T00:00:00Z" }),
    ).toBe(false);

    const escalated = { ...task, status: "escalated" as const };
    expect(canApproveTask(escalated)).toBe(true);
    expect(
      renderToStaticMarkup(
        createElement(BuildTaskCard, {
          task: escalated,
          busy: false,
          onApprove: vi.fn(),
        }),
      ),
    ).toContain("Approve retry");
    expect(
      canApproveTask({ ...escalated, closed_at: "2026-10-15T00:00:00Z" }),
    ).toBe(false);
  });

  it("renders Build navigation and an initial connecting state", () => {
    const markup = renderToStaticMarkup(
      createElement(Workbench, {
        projectId: "project-1",
        initialMode: "build",
      }),
    );
    expect(markup).toContain('aria-label="Project workspace"');
    expect(markup).toContain("Your build, as it happens");
    expect(markup).toContain("Connecting to build…");
    expect(
      renderToStaticMarkup(
        createElement(BuildDashboard, { projectId: "project-2" }),
      ),
    ).toContain("project-2");
  });

  it("reads and approves with trusted authentication and the displayed revision", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(snapshot))),
      );
    const client = createBuildClient(transport);
    expect(await client.read("project/one")).toEqual(snapshot);
    expect(await client.approve("project/one", "T/1", task.revision)).toEqual(
      snapshot,
    );
    expect(transport.mock.calls).toEqual([
      ["/api/v1/projects/project%2Fone/build", { credentials: "same-origin" }],
      [
        "/api/v1/projects/project%2Fone/build/tasks/T%2F1/approve",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: task.revision }),
        },
      ],
    ]);
  });

  it("replaces snapshots on reconnect and detaches the stream when leaving a project", () => {
    const stream = new MockStream();
    const open = vi.fn(() => stream);
    const receive = vi.fn();
    const connection = vi.fn();
    const unsubscribe = createBuildClient(fetch, open).subscribe(
      "project/one",
      receive,
      connection,
    );
    expect(open).toHaveBeenCalledWith(
      "/api/v1/projects/project%2Fone/build/stream",
    );
    stream.send("snapshot", snapshot);
    stream.onerror?.call({} as EventSource, new Event("error"));
    stream.send("snapshot", {
      ...snapshot,
      tasks: [{ ...task, status: "completed" }],
    });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[1]?.[0]).toMatchObject({
      tasks: [{ status: "completed" }],
    });
    expect(connection.mock.calls.flat()).toEqual([
      "connecting",
      "live",
      "reconnecting",
      "live",
    ]);
    unsubscribe();
    stream.send("snapshot", snapshot);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("shows terminal transport failures as offline until manually refreshed", () => {
    const stream = new MockStream();
    const connection = vi.fn();
    createBuildClient(fetch, () => stream).subscribe(
      "project",
      vi.fn(),
      connection,
    );
    stream.readyState = 2;
    stream.onerror?.call({} as EventSource, new Event("error"));
    expect(connection).toHaveBeenLastCalledWith("offline");
  });

  it("rejects malformed events and stops a stream when access is revoked", () => {
    const stream = new MockStream();
    const receive = vi.fn();
    const connection = vi.fn();
    createBuildClient(fetch, () => stream).subscribe(
      "project",
      receive,
      connection,
    );
    stream.send("snapshot", { tasks: [] });
    expect(receive).not.toHaveBeenCalled();
    expect(connection).toHaveBeenLastCalledWith("reconnecting");
    stream.send("unavailable", {});
    expect(connection).toHaveBeenLastCalledWith("offline");
    expect(stream.close).toHaveBeenCalledOnce();
    stream.send("snapshot", snapshot);
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Sign in"],
    [404, "unavailable"],
    [409, "task changed"],
    [500, "Retry shortly"],
  ])(
    "explains HTTP %i without leaking internal text",
    async (status, message) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private stack trace", { status }));
      await expect(
        createBuildClient(transport).approve("project", "task", task.revision),
      ).rejects.toThrow(message);
    },
  );
});
