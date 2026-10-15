import { createRoot } from "react-dom/client";
import { AskInterface } from "./AskInterface.js";
import "./styles.css";

const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
const params = new URLSearchParams(window.location.search);
const projectId = params.get("project") ?? "";
createRoot(element).render(
  projectId ? (
    <AskInterface projectId={projectId} />
  ) : (
    <main className="ask-workspace">
      <h1>Software Factory</h1>
      <p>Open a project to start planning.</p>
      <form method="get">
        <label htmlFor="project">Project ID</label>
        <input
          id="project"
          name="project"
          required
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        />
        <button type="submit">Open project</button>
      </form>
    </main>
  ),
);
