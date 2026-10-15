/**
 * Factory domain primitive: Relation.
 *
 * A relation is a typed edge between two references, expressing lineage and
 * dependency. The taxonomy is not hard-coded into the core (docs/06); the
 * `kind` field carries the relation type.
 *
 * Useful conventions: triggered-by, created-from, depends-on, blocked-by,
 * performed-by, produced, verified-by, retry-of, derived-from.
 */
export interface Relation {
  readonly id: string;
  readonly tenantId: string;
  readonly fromRef: string;
  readonly toRef: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}