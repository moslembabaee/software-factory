import pg from "pg";

export interface TenantIdentity {
  tenantId: string;
  actorId: string;
}

export interface TenantDatabase {
  withTenant<T>(
    identity: TenantIdentity,
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runtime credentials must belong to a non-superuser without BYPASSRLS. */
export function createApplicationPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env["API_DATABASE_URL"] ?? process.env["DATABASE_URL"] ??
      "postgres://sf:sf_dev_pw@127.0.0.1:5432/software_factory",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
}

export class PostgresDatabase implements TenantDatabase {
  constructor(private readonly pool: Pick<pg.Pool, "connect">) {}

  async withTenant<T>(
    identity: TenantIdentity,
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!uuid.test(identity.tenantId) || !uuid.test(identity.actorId)) {
      throw new Error("Invalid trusted tenant identity");
    }
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const role = await client.query<{ unsafe: boolean }>(
        "SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = current_user",
      );
      if (role.rows[0]?.unsafe !== false) {
        throw new Error("API database role must enforce row level security");
      }
      // true makes these settings transaction-local, including on pooled connections.
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
        [identity.tenantId, identity.actorId],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = new Error("Failed to roll back tenant transaction");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
