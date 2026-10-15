import {
  AskAcceptanceSchema,
  AskPlanSchema,
  type AskAcceptance,
  type AskPlan,
} from "@software-factory/factory-core";

export interface AskClient {
  preview(projectId: string, description: string): Promise<AskPlan>;
  accept(
    projectId: string,
    description: string,
    key: string,
  ): Promise<AskAcceptance>;
}

/** The host supplies trusted authentication; the UI never sends tenant identity headers. */
export function createAskClient(transport: typeof fetch = fetch): AskClient {
  async function post(
    projectId: string,
    suffix: string,
    body: object,
    key?: string,
  ): Promise<unknown> {
    const response = await transport(
      `/api/v1/projects/${encodeURIComponent(projectId)}/ask${suffix}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "Sign in before creating a plan.",
        403: "You do not have access to this project.",
        404: "This project is unavailable. Check the selected project.",
        409: "This request conflicts with an earlier acceptance. Generate a new plan.",
        422: "Describe between 1 and 12 requirements using at most 10,000 characters.",
        429: "The service is busy. Retry this request shortly.",
      };
      throw new Error(
        messages[response.status] ??
          "The request could not be completed. Retry with the same plan.",
      );
    }
    return response.json() as Promise<unknown>;
  }
  return {
    preview: async (projectId, description) =>
      AskPlanSchema.parse(await post(projectId, "", { description })),
    accept: async (projectId, description, key) =>
      AskAcceptanceSchema.parse(
        await post(projectId, "/tasks", { description, accepted: true }, key),
      ),
  };
}
