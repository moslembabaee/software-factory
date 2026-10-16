import { useEffect, useRef, useState } from "react";
import {
  canApproveTask,
  type BuildSnapshot,
  type BuildTask,
  type BuildMetrics,
} from "@software-factory/factory-core";
import {
  createBuildClient,
  type BuildClient,
  type BuildConnection,
} from "./build-client.js";

const defaultClient = createBuildClient();
const usd = (value: number) => `$${value.toFixed(6)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function BuildMetricsPanel({ metrics }: { metrics: BuildMetrics }) {
  const modes = Object.entries(metrics.failure_modes);
  const maxFailures = Math.max(1, ...modes.map(([, count]) => count ?? 0));
  return (
    <section aria-labelledby="build-metrics-heading" className="build-metrics">
      <h2 id="build-metrics-heading">Runtime metrics</h2>
      <p>
        Costs use configured token rates. Token estimates are marked per task.
        Budgets stop further dispatch; a running invocation can exceed its cap.
      </p>
      <dl className="metric-grid">
        <div>
          <dt>Tokens</dt>
          <dd>{metrics.total_tokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>{usd(metrics.total_cost_usd)}</dd>
        </div>
        <div>
          <dt>Average attempt latency</dt>
          <dd>{metrics.avg_latency_seconds.toFixed(2)}s</dd>
        </div>
        <div>
          <dt>Retry rate</dt>
          <dd>{percent(metrics.retry_rate)}</dd>
        </div>
      </dl>
      <p>
        Attempts: {metrics.attempt_count}. Retry rate counts attempts after the
        first for each task.
      </p>
      {metrics.budget.exceeded && (
        <p role="status">A task has reached its budget limit.</p>
      )}
      {metrics.agents.length > 0 && (
        <div className="metrics-table-scroll">
          <table className="metrics-table">
            <caption>Agent performance</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Attempts</th>
                <th scope="col">Tokens</th>
                <th scope="col">Estimated cost</th>
                <th scope="col">Avg. latency</th>
                <th scope="col">Failures</th>
              </tr>
            </thead>
            <tbody>
              {metrics.agents.map((agent) => (
                <tr key={agent.agent}>
                  <th scope="row">{agent.agent}</th>
                  <td>{agent.attempt_count}</td>
                  <td>{agent.total_tokens.toLocaleString()}</td>
                  <td>{usd(agent.total_cost_usd)}</td>
                  <td>{agent.avg_latency_seconds.toFixed(2)}s</td>
                  <td>{agent.failed_attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Failure modes</h3>
      {modes.length === 0 ? (
        <p>No recorded failures.</p>
      ) : (
        <ul className="failure-modes">
          {modes.map(([mode, count]) => (
            <li key={mode}>
              <span>
                {mode.replaceAll("_", " ")}: {count}
              </span>
              <meter
                min={0}
                max={maxFailures}
                value={count}
                aria-label={`${mode.replaceAll("_", " ")} failures`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BudgetControl({
  task,
  disabled,
  onSave,
}: {
  task: BuildTask;
  disabled: boolean;
  onSave: (cap: number | null) => void;
}) {
  const [value, setValue] = useState(task.budget_cap_usd?.toString() ?? "");
  return (
    <form
      className="budget-control"
      onSubmit={(event) => {
        event.preventDefault();
        const cap = value.trim() === "" ? null : Number(value);
        if (cap === null || (Number.isFinite(cap) && cap >= 0)) onSave(cap);
      }}
    >
      <label htmlFor={`budget-${task.id}`}>Task budget (USD)</label>
      <input
        id={`budget-${task.id}`}
        type="number"
        min="0"
        step="any"
        placeholder="No limit"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" disabled={disabled}>
        Save budget
      </button>
    </form>
  );
}
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
  onSetBudget,
}: {
  task: BuildTask;
  busy: boolean;
  disabled?: boolean;
  onApprove: () => void;
  onSetBudget?: (cap: number | null) => void;
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
      {task.active_attempt && (
        <p role="status">
          Running {task.active_attempt.agent}: {task.active_attempt.phase}
          {" · "}
          {task.active_attempt.elapsed_seconds.toFixed(1)}s elapsed
        </p>
      )}
      {task.telemetry && (
        <div className="task-telemetry">
          <p>
            {task.telemetry.tokens.total.toLocaleString()} tokens
            {task.telemetry.estimated_tokens ? " (estimated)" : " (reported)"}
            {" · "}
            {usd(task.telemetry.cost_usd)} estimated cost
            {" · "}
            {task.telemetry.duration_seconds.toFixed(2)}s total
          </p>
          <p>
            Agent: {task.telemetry.agent_duration_seconds.toFixed(2)}s ·
            Verification:{" "}
            {task.telemetry.verification_duration_seconds.toFixed(2)}s{" · "}
            Retry rate: {percent(task.telemetry.retry_rate)}
          </p>
          {task.telemetry.budget.cap_usd !== null && (
            <>
              <label htmlFor={`budget-progress-${task.id}`}>
                Budget: {usd(task.telemetry.cost_usd)} /{" "}
                {usd(task.telemetry.budget.cap_usd)}
              </label>
              <progress
                id={`budget-progress-${task.id}`}
                max={task.telemetry.budget.cap_usd || 1}
                value={
                  task.telemetry.budget.cap_usd === 0
                    ? 1
                    : Math.min(
                        task.telemetry.cost_usd,
                        task.telemetry.budget.cap_usd,
                      )
                }
              />
              {task.telemetry.budget.exceeded && (
                <p role="status">Budget limit reached</p>
              )}
            </>
          )}
        </div>
      )}
      {!task.closed_at && onSetBudget && (
        <BudgetControl
          key={String(task.budget_cap_usd)}
          task={task}
          disabled={busy || disabled}
          onSave={onSetBudget}
        />
      )}
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
  async function setBudget(task: BuildTask, cap: number | null) {
    if (busy) return;
    setBusy(task.id);
    setError("");
    try {
      const next = await client.setBudget(projectId, task.id, {
        revision: task.revision,
        budget_cap_usd: cap,
      });
      if (active.current) setSnapshot(next);
    } catch (cause) {
      if (active.current) {
        setError(
          cause instanceof Error ? cause.message : "Budget update failed.",
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
          {snapshot.metrics && <BuildMetricsPanel metrics={snapshot.metrics} />}
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
                    onSetBudget={(cap) => {
                      void setBudget(task, cap);
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
