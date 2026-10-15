# SF-ADR-003 — S3-Compatible Encrypted Content-Addressed Object Storage

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Artifacts, patches, evidence and other blobs must be stored durably and referenced from lifecycle records. External systems keep ownership of their artifacts (LEGACY14-ADR-016); the factory stores its own content. Blobs need integrity verification, tenant isolation and protection against unauthorized reads.

## Decision

Store objects in **S3-compatible encrypted content-addressed object storage**.

**Invariant (normative):** tenant-bound metadata and checksum verification.

## Consequences

- Object keys are derived from content (content addressing); identical content deduplicates naturally.
- Metadata is bound to the tenant that created it; every record and artifact carries a server-derived tenant_id.
- Checksums are verified on read/write; corruption is detected rather than silently propagated.
- Encryption at rest is required; key provider choice remains an operator input.
- Any S3-compatible provider satisfies the decision — the adapter is vendor-neutral, not locked to one cloud.