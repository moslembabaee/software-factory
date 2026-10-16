import {
  BuildSnapshotSchema,
  type BuildSnapshot,
  type BuildBudgetUpdate,
} from "@software-factory/factory-core";

export type BuildConnection =
  "connecting" | "live" | "reconnecting" | "offline";
export interface BuildClient {
  setBudget(
    projectId: string,
    taskId: string,
    update: BuildBudgetUpdate,
  ): Promise<BuildSnapshot>;
  read(projectId: string, signal?: AbortSignal): Promise<BuildSnapshot>;
  approve(
    projectId: string,
    taskId: string,
    revision: string,
  ): Promise<BuildSnapshot>;
  subscribe(
    projectId: string,
    onSnapshot: (value: BuildSnapshot) => void,
    onConnection: (state: BuildConnection) => void,
  ): () => void;
}
export type BuildEventSource = Pick<EventTarget, "addEventListener"> &
  Pick<EventSource, "close" | "onerror" | "readyState">;
export function createBuildClient(
  transport: typeof fetch = fetch,
  openStream: (url: string) => BuildEventSource = (url) => new EventSource(url),
): BuildClient {
  const path = (project: string) =>
    `/api/v1/projects/${encodeURIComponent(project)}/build`;
  async function request(
    url: string,
    options: RequestInit,
  ): Promise<BuildSnapshot> {
    const response = await transport(url, {
      ...options,
      credentials: "same-origin",
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "Sign in to view this build.",
        403: "You do not have access to this build.",
        404: "This project or task is unavailable.",
        409: "The task changed. Review its latest status before approving.",
      };
      throw new Error(
        messages[response.status] ?? "Build unavailable. Retry shortly.",
      );
    }
    return BuildSnapshotSchema.parse(await response.json());
  }
  return {
    setBudget: (project, task, update) =>
      request(`${path(project)}/tasks/${encodeURIComponent(task)}/budget`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }),
    read: (project, signal) =>
      request(path(project), { ...(signal ? { signal } : {}) }),
    approve: (project, task, revision) =>
      request(`${path(project)}/tasks/${encodeURIComponent(task)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision }),
      }),
    subscribe: (project, onSnapshot, onConnection) => {
      onConnection("connecting");
      const stream = openStream(`${path(project)}/stream`);
      let closed = false;
      stream.addEventListener("snapshot", (event) => {
        if (closed) return;
        try {
          if (!("data" in event) || typeof event.data !== "string")
            throw new Error("Invalid event");
          const value = BuildSnapshotSchema.parse(JSON.parse(event.data));
          onSnapshot(value);
          onConnection("live");
        } catch {
          onConnection("reconnecting");
        }
      });
      stream.addEventListener("unavailable", () => {
        if (!closed) {
          onConnection("offline");
          stream.close();
          closed = true;
        }
      });
      stream.onerror = () => {
        if (!closed)
          onConnection(stream.readyState === 2 ? "offline" : "reconnecting");
      };
      return () => {
        closed = true;
        stream.close();
      };
    },
  };
}
