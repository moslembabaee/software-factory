import { useState, type FormEvent } from "react";
import type { AskPlan } from "@software-factory/factory-core";
import { createAskClient, type AskClient } from "./ask-client.js";

const defaultClient = createAskClient();

interface Props {
  projectId: string;
  projectName?: string;
  client?: AskClient;
}

/** Keying the session by project prevents a late response appearing in another project. */
export function AskInterface(props: Props) {
  return <AskSession key={props.projectId} {...props} />;
}

function AskSession({
  projectId,
  projectName = projectId,
  client = defaultClient,
}: Props) {
  const [description, setDescription] = useState("");
  const [proposal, setProposal] = useState<{
    plan: AskPlan;
    key: string;
  } | null>(null);
  const [busy, setBusy] = useState<"preview" | "accept" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<number | null>(null);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!description.trim() || busy) return;
    setBusy("preview");
    setError("");
    setProposal(null);
    setSaved(null);
    try {
      const plan = await client.preview(projectId, description);
      setProposal({ plan, key: crypto.randomUUID() });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not generate a plan. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function accept() {
    if (!proposal || busy || saved !== null) return;
    setBusy("accept");
    setError("");
    try {
      const result = await client.accept(
        projectId,
        proposal.plan.description,
        proposal.key,
      );
      setSaved(result.tasks.length);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the tasks. Retry this plan.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="ask-workspace">
      <header>
        <p className="eyebrow">
          Software Factory <span className="mode">Ask</span>
        </p>
        <h1>What would you like to build?</h1>
        <p>
          Turn your idea into a plan you can review, one requirement at a time.
        </p>
        <p className="project">
          Project: <strong>{projectName || "Select a project"}</strong> ·
          Environment: Local · Context: Your description
        </p>
      </header>
      <form
        onSubmit={(event) => {
          void preview(event);
        }}
        aria-busy={busy !== null}
      >
        <label htmlFor="ask-description">Describe what you want</label>
        <textarea
          id="ask-description"
          rows={6}
          maxLength={10_000}
          required
          placeholder="Build a team dashboard. Let members track their tasks and see weekly progress."
          value={description}
          disabled={busy !== null}
          aria-describedby="ask-help"
          onChange={(event) => {
            setDescription(event.target.value);
            setProposal(null);
            setSaved(null);
            setError("");
          }}
        />
        <p id="ask-help">
          Use a sentence or a separate line for each requirement, up to 12.
          Generating a plan is read-only.
        </p>
        <button
          type="submit"
          disabled={!projectId || !description.trim() || busy !== null}
        >
          {busy === "preview" ? "Drafting plan…" : "Generate plan"}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {busy === "preview"
            ? "Preparing your proposal…"
            : "Saving pending tasks…"}
        </p>
      )}
      {proposal && (
        <section aria-labelledby="plan-heading">
          <div className="plan-heading">
            <h2 id="plan-heading">Your proposed plan</h2>
            <span>{proposal.plan.tasks.length} tasks</span>
          </div>
          <p className="request">{proposal.plan.description}</p>
          <ol className="tasks">
            {proposal.plan.tasks.map((task, index) => (
              <li key={index}>
                <p className="task-meta">
                  {task.phase} <span>Agent: {task.assigned_agent}</span>
                </p>
                <h3>{task.title}</h3>
                <p>{task.description}</p>
                <details>
                  <summary>Verification gates</summary>
                  <ul>
                    {task.verification_gates.map((gate) => (
                      <li key={gate}>{gate}</li>
                    ))}
                  </ul>
                  <code>{task.verification_cmd}</code>
                </details>
              </li>
            ))}
          </ol>
          <h3>Assumptions to review</h3>
          <ul>
            {proposal.plan.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
          <p>
            Accepting adds pending tasks to the roadmap. Each task needs
            separate approval before work starts.
          </p>
          <button
            type="button"
            disabled={busy !== null || saved !== null}
            onClick={() => {
              void accept();
            }}
          >
            {busy === "accept"
              ? "Saving…"
              : saved !== null
                ? "Tasks saved"
                : "Accept plan and save pending tasks"}
          </button>
        </section>
      )}
      {saved !== null && (
        <p className="success" role="status">
          Saved {saved} pending tasks. They are awaiting approval.
        </p>
      )}
    </main>
  );
}
