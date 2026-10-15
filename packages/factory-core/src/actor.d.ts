/**
 * Factory domain primitive: Actor.
 *
 * An actor is any principal that can initiate or perform work in the factory:
 * a human user, an agent, or an external system. Actors are tenant-scoped and
 * uniquely identified within a tenant by their subject (e.g. OIDC subject or
 * adapter key). See SF-ADR-005: identity is server-resolved, never
 * client-selected.
 */
export type ActorKind = "human" | "agent" | "system" | "external";
export interface Actor {
    readonly id: string;
    readonly tenantId: string;
    /** Stable subject within the tenant, e.g. OIDC subject or adapter key. */
    readonly subject: string;
    readonly kind?: ActorKind;
    /** Adapter key when this actor is backed by an external capability. */
    readonly adapterKey?: string;
    readonly tags?: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
}
