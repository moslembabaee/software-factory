/**
 * Factory value object type.
 *
 * A ValueObject represents an immutable concept in the domain that is
 * identified by its structural equality (all fields compared) rather than
 * by a stable identity. Value objects are encoded as branded `Readonly`
 * records to enable structural typing checks at the type level.
 *
 * The `T` generic captures the underlying shape; branding via `__brand`
 * prevents accidental structural assignment across different value-object
 * types (docs/06 domain model section).
 */
export type ValueObject<T extends Record<string, unknown>> = Readonly<T> & {
  /** Structural brand discriminator for nominal type safety. */
  readonly __brand: "value-object";
};

/**
 * Helper to tag a value-object shape with the branded type.
 */
export type BrandValueObject<T extends Record<string, unknown>> = ValueObject<T>;