# Changelog

## 1.0.0-rc.1 - 2026-07-24

- Completed P2-P9 deterministic acceptance for spatial reconstruction, shell modeling, hard finishes, furnishing/assets, Viewer/WebXR, Blender/360°, revisions and expanded inputs.
- Added a persistent production job state machine with idempotency, bounded retries, checkpoints, pause/resume, cancellation, tamper-evident events and redacted observability.
- Added ownership-token runtime locks, crash recovery, active cancellation and checkpoint/definition verification.
- Added production handler contracts, output-workspace containment and symbolic-link rejection; removed arbitrary command execution from job definitions.
- Added Linux/macOS/Windows CI configuration, host diagnostics and commit-bound platform evidence; pinned all workflow actions to full commits.
- Added input file/count limits, hash-bound single-read visual inputs, no-shell converter execution, provider response/SSRF/image validation, hardened Viewer serving and security/privacy/license audit.
- Upgraded Sharp to 0.35.3 and AJV to 8.18.0 to consume their upstream security fixes.
- Added scene budgets, current-host core benchmarks and strict actual-device qualification records for desktop, mobile, XR and Blender.
- Added dry-run-first migrations with backups, credential rejection, forced legacy-job review and protected Spatial/approval boundaries.
- Added delivery manifests, complete embedded qualification records, commit-safe protected-secret transport, candidate/production packaging and integrity verification.
- Added all-lockfile license/SRI auditing and CycloneDX output with unique component references, correct scoped PURLs and a full dependency graph.
- Added release verification for SHA-256, npm SHA-1/SHA-512, SBOM identity/component count, manifest, preflight, version and tag.
- Added user, deployment, troubleshooting, qualification, security and release documentation.

This version remains a release candidate. Stable release is blocked until the final commit has real three-platform CI evidence, physical desktop/mobile/XR/Blender qualification and at least one interactively accepted anonymized real project.
