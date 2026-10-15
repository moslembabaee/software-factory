import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  PendingTaskSchema,
  type AskPlan,
  type PendingTask,
} from "@software-factory/factory-core";
import type { TenantIdentity } from "@software-factory/storage";
import { ApiError } from "./errors.js";

export interface AskRoadmap {
  accept(
    plan: AskPlan,
    identity: TenantIdentity,
    projectId: string,
    key: string,
  ): Promise<PendingTask[]>;
}

function repositoryRoadmap(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "roadmap_store.py"))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Software Factory repository root not found");
    directory = parent;
  }
  return join(directory, "ROADMAP.json");
}

// Use the same Linux advisory lock and atomic replacement as roadmap_store.py.
// Input travels over stdin; neither prompt text nor paths are interpolated as code.
const appendScript = String.raw`
import fcntl, json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
incoming = json.load(sys.stdin)
with path.with_suffix('.json.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
        raise ValueError('Invalid roadmap')
    receipts = data.setdefault('ask_intakes', {})
    if not isinstance(receipts, dict):
        raise ValueError('Invalid intake receipts')
    receipt = receipts.get(incoming['key'])
    if receipt is not None:
        if receipt['hash'] != incoming['hash']:
            print(json.dumps({'conflict': True}))
        else:
            print(json.dumps({'tasks': receipt['tasks']}))
    else:
        ids = {task['id'] for task in data['tasks']}
        if any(task['id'] in ids for task in incoming['tasks']):
            raise ValueError('Task ID collision')
        data['tasks'].extend(incoming['tasks'])
        receipts[incoming['key']] = {'hash': incoming['hash'], 'tasks': incoming['tasks']}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False, encoding='utf-8') as output:
                temporary = pathlib.Path(output.name)
                temporary.chmod(path.stat().st_mode & 0o777)
                json.dump(data, output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(json.dumps({'tasks': incoming['tasks']}))
`;

/** File receipts make retries safe even if the response or DB connection is lost. */
export class FileAskRoadmap implements AskRoadmap {
  constructor(private readonly path = repositoryRoadmap()) {}

  async accept(
    plan: AskPlan,
    identity: TenantIdentity,
    projectId: string,
    key: string,
  ): Promise<PendingTask[]> {
    const intakeId = randomUUID();
    const tasks = plan.tasks.map((task) =>
      PendingTaskSchema.parse({
        ...task,
        id: `T-ASK-${randomUUID()}`,
        status: "pending",
        retry_count: 0,
        tenant_id: identity.tenantId,
        project_id: projectId,
        created_by: identity.actorId,
        created_at: new Date().toISOString(),
        intake_id: intakeId,
      }),
    );
    const payload = {
      key: createHash("sha256")
        .update(
          JSON.stringify([identity.tenantId, identity.actorId, projectId, key]),
        )
        .digest("hex"),
      hash: createHash("sha256").update(plan.description).digest("hex"),
      tasks,
    };
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = execFile(
        "python3",
        ["-c", appendScript, this.path],
        {
          timeout: 10_000,
          maxBuffer: 2_000_000,
        },
        (error, stdout) => {
          if (error)
            reject(new Error("Roadmap persistence failed", { cause: error }));
          else resolveOutput(stdout);
        },
      );
      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify(payload));
    });
    const result: unknown = JSON.parse(output);
    if (z.object({ conflict: z.literal(true) }).safeParse(result).success) {
      throw new ApiError(
        409,
        "CONFLICT",
        "Idempotency key was used with a different request",
      );
    }
    return z.object({ tasks: z.array(PendingTaskSchema).min(1) }).parse(result)
      .tasks;
  }
}
