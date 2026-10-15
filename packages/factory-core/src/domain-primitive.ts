/**
 * Factory domain primitive: DomainPrimitive.
 *
 * A DomainPrimitive is the foundational building block of the domain model.
 * Every domain entity or value object carries an `id` for stable identity
 * within its tenant scope, a `tenantId` for multi-tenancy, and a `createdAt`
 * timestamp. All fields are immutable after creation.
 *
 * See SF-ADR-002: transactional relational state with immutable event log.
 */
export interface DomainPrimitive {
  readonly id: string;
  readonly tenantId: string;
  readonly createdAt: string;
}