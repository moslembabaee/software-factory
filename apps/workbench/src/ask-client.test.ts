import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { proposeTasks } from "@software-factory/factory-core";
import { createAskClient } from "./ask-client.js";
import { AskInterface } from "./AskInterface.js";

describe("Ask workbench", () => {
  it("renders an accessible composer with project context and a read-only explanation", () => {
    const markup = renderToStaticMarkup(
      createElement(AskInterface, {
        projectId: "project-1",
        projectName: "<script>Project</script>",
      }),
    );
    expect(markup).toContain('for="ask-description"');
    expect(markup).toContain('maxLength="10000"');
    expect(markup).toContain("Generating a plan is read-only");
    expect(markup).toContain("&lt;script&gt;Project&lt;/script&gt;");
    expect(markup).not.toContain("Accept plan");
    expect(markup).toContain('disabled=""');
  });

  it("requests a preview without acceptance or tenant headers", async () => {
    const plan = proposeTasks({ description: "Build a dashboard" });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(plan)));
    const client = createAskClient(transport);
    expect(await client.preview("project/one", plan.description)).toEqual(plan);
    expect(transport).toHaveBeenCalledWith(
      "/api/v1/projects/project%2Fone/ask",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: plan.description }),
      },
    );
  });

  it("uses explicit acceptance and preserves the caller's retry key", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const client = createAskClient(transport);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        client.accept("project", "Build", "stable-retry-key"),
      ).rejects.toThrow("Retry with the same plan");
    }
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, options] of transport.mock.calls) {
      expect(options?.headers).toEqual({
        "content-type": "application/json",
        "idempotency-key": "stable-retry-key",
      });
      if (typeof options?.body !== "string")
        throw new Error("Expected a JSON body");
      expect(JSON.parse(options.body)).toEqual({
        description: "Build",
        accepted: true,
      });
    }
  });

  it.each([
    [401, "Sign in"],
    [404, "unavailable"],
    [422, "12 requirements"],
    [429, "busy"],
  ])(
    "explains HTTP %i without showing internal response text",
    async (status, message) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("secret internal details", { status }));
      await expect(
        createAskClient(transport).preview("project", "Build"),
      ).rejects.toThrow(message);
    },
  );

  it("rejects malformed success payloads", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"tasks":[]}'));
    await expect(
      createAskClient(transport).preview("project", "Build"),
    ).rejects.toThrow();
  });
});
