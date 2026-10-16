import { useEffect, useRef, useState } from "react";
import {
  canApproveTask,
  type BuildSnapshot,
  type BuildTask,
} from "@software-factory/factory-core";
import {
  createBuildClient,
  type BuildClient,
  type BuildConnection,
} from "./build-client.js";

const defaultClient = createBuildClient();
interface Props {
  projectId: string;
  client?: BuildClient;
}
export function BuildDashboard(props: Props) {
  return <BuildSession key={props.projectId} {...props} />;
}

export function BuildProgress({ snapshot }: { snapshot: BuildSnapshot }) {
  const completed = snapshot.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  return (
    <div className="build-progress">
      <label htmlFor="build-progress">
        {completed} of {snapshot.tasks.length} tasks completed
      </label>
      <progress
        id="build-progress"
        max={Math.max(1, snapshot.tasks.length)}
        value={completed}
      />
    </div>
  );
}

export function BuildTaskCard({
  task,
  busy,
  disabled = false,
  onApprove,
}: {
  task: BuildTask;
  busy: boolean;
  disabled?: boolean;
  onApprove: () => void;
}) {
  return (
    <li className="build-task">
      <div className="plan-heading">
        <h3>{task.title}</h3>
        <span className={`task-status status-${task.status}`}>
          {task.status.replaceAll("_", " ")}
        </span>
      </div>
      <p className="task-meta">
        {task.id} · {task.phase} · Agent: {task.assigned_agent || "Unassigned"}{" "}
        · Retries: {task.retry_count}
      </p>
      <p>{task.description}</p>
      {task.github_issue_number && (
        <p>
          GitHub issue #{task.github_issue_number}
          {task.closed_at ? " · Closed" : " · Linked"}
        </p>
      )}
      {task.commit_sha && (
        <p>
          Commit: <code>{task.commit_sha}</code>
        </p>
      )}
      {canApproveTask(task) && (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={onApprove}
          aria-label={`Approve ${task.title}`}
        >
          {busy
            ? "Approving…"
            : task.status === "failed" || task.status === "escalated"
              ? "Approve retry"
              : "Approve task"}
        </button>
      )}
    </li>
  );
}

function BuildSession({ projectId, client = defaultClient }: Props) {
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null);
  const [connection, setConnection] = useState<BuildConnection>("connecting");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    const controller = new AbortController();
    setConnection("connecting");
    void client
      .read(projectId, controller.signal)
      .then((value) => {
        if (!alive) return;
        setSnapshot(value);
        unsubscribe = client.subscribe(
          projectId,
          (next) => {
            if (alive) setSnapshot(next);
          },
          (state) => {
            if (alive) setConnection(state);
          },
        );
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setConnection("offline");
        setError(cause instanceof Error ? cause.message : "Build unavailable.");
      });
    return () => {
      alive = false;
      active.current = false;
      controller.abort();
      unsubscribe?.();
    };
  }, [projectId, client, refresh]);

  async function approve(task: BuildTask) {
    if (busy) return;
    setBusy(task.id);
    setError("");
    try {
      const next = await client.approve(projectId, task.id, task.revision);
      if (active.current) setSnapshot(next);
    } catch (cause) {
      if (active.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Approval failed. Refresh before retrying.",
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      if (active.current) setBusy(null);
    }
  }
  return (
    <main className="ask-workspace build-workspace">
      <header>
        <p className="eyebrow">
          Software Factory <span className="mode">Build</span>
        </p>
        <h1>Your build, as it happens</h1>
        <p className="project">
          Project: <strong>{projectId}</strong>
        </p>
        <p role="status">
          {connection === "live"
            ? "Live updates connected"
            : connection === "reconnecting"
              ? "Connection interrupted. Reconnecting…"
              : connection === "offline"
                ? "Updates disconnected. Showing the last received state."
                : "Connecting to build…"}
        </p>
        <button
          type="button"
          onClick={() => {
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh connection
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          <section aria-labelledby="build-tasks-heading">
            <h2 id="build-tasks-heading">Task progress</h2>
            <BuildProgress snapshot={snapshot} />
            {snapshot.current_task_id && (
              <p>Running: {snapshot.current_task_id}</p>
            )}
            <p>
              Approval authorizes the orchestrator to start this task. Failed
              tasks require approval to retry.
            </p>
            {!snapshot.tasks.length ? (
              <p>No tasks yet. Create and accept a plan in Ask.</p>
            ) : (
              <ul className="build-tasks">
                {snapshot.tasks.map((task) => (
                  <BuildTaskCard
                    key={task.id}
                    task={task}
                    busy={busy === task.id}
                    disabled={busy !== null || connection !== "live"}
                    onApprove={() => {
                      void approve(task);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="build-logs-heading">
            <h2 id="build-logs-heading">Live activity</h2>
            <p>
              Recent task activity from the orchestrator, GitHub webhook, and
              approvals. Showing up to 200 entries.
            </p>
            <div
              className="build-logs"
              role="log"
              aria-label="Build activity"
              aria-live="polite"
              aria-relevant="additions"
            >
              {!snapshot.logs.length ? (
                <p>No activity yet.</p>
              ) : (
                snapshot.logs.map((entry) => (
                  <p key={entry.id}>
                    <time dateTime={entry.timestamp}>{entry.timestamp}</time> [
                    {entry.source}] {entry.task_id}: {entry.message}
                  </p>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
