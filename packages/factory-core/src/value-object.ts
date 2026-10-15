/**
 * Factory value object type.
 *
 * A ValueObject represents an immutable concept in the domain that is
 * identified by its structural equality (all fields compared) rather than
 * by a stable identity. Value objects are encoded as branded `Readonly`
 * records to enable type-level distinction.
 *
 * The `T` generic captures the underlying shape; the `__brand` field
 * prevents accidental structural assignment across unrelated value objects.
 */
export type ValueObject<T> = Readonly<T> & {
  /** Brand discriminator for nominal type safety. */
  readonly __brand: "value-object";
};