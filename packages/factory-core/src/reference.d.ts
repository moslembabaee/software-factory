/**
 * Factory domain primitive: Reference.
 *
 * A reference points at a stable addressable object (URI, tenant-bound id,
 * object key). External objects remain external: the factory stores the
 * reference plus minimal display metadata, never a wholesale copy.
 */
export interface Reference {
    readonly id: string;
    readonly tenantId: string;
    readonly kind: string;
    /** Canonical stable URI of the referenced object. */
    readonly uri: string;
    /** Target id when the reference resolves to a factory entity. */
    readonly targetId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
}
