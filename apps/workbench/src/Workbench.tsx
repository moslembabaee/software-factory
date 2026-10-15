import { useState } from "react";
import { AskInterface } from "./AskInterface.js";
import { BuildDashboard } from "./BuildDashboard.js";

export function Workbench({
  projectId,
  initialMode = "ask",
}: {
  projectId: string;
  initialMode?: "ask" | "build";
}) {
  const [mode, setMode] = useState(initialMode);
  return (
    <>
      <nav className="workspace-nav" aria-label="Project workspace">
        <button
          type="button"
          aria-pressed={mode === "ask"}
          onClick={() => {
            setMode("ask");
          }}
        >
          Ask
        </button>
        <button
          type="button"
          aria-pressed={mode === "build"}
          onClick={() => {
            setMode("build");
          }}
        >
          Build
        </button>
      </nav>
      {mode === "ask" ? (
        <AskInterface key={projectId} projectId={projectId} />
      ) : (
        <BuildDashboard projectId={projectId} />
      )}
    </>
  );
}
