# Security

## Release status

`1.0.0-rc.1` is a release candidate and is not yet fully production-qualified. No stable supported version exists until P10 has complete cross-platform, device, renderer, and anonymized real-project evidence.

## Reporting a vulnerability

Do not place credentials, customer plans, addresses, private images, or exploit details in a public issue. Use the repository's private security-advisory channel when available and include only the minimum reproducible information. Revoke any credential that may have been exposed before waiting for a code fix.

## Trust boundaries

- Spatial JSON is the only spatial source of truth.
- Production downstream work requires a separate, hash-bound, Ed25519-signed human approval.
- Test approvals never authorize customer work.
- External-provider commands require explicit per-command authorization for the named provider and exact data.
- Production job definitions use a fixed handler registry; arbitrary shell commands are not supported.
- Local converters run with `shell: false`, bounded arguments, timeouts and output limits.
- Inputs are bounded regular files; delivery files must remain below an explicit root and cannot be symbolic links.

## Sensitive data

Keep `.env`, reviewer private keys, customer inputs, runtime directories and generated deliveries out of Git. Runtime audit events allowlist operational fields and redact credentials, local paths and contact data. Security findings store a hash of suspicious evidence rather than echoing its value.

The repository scanner checks common secrets, tracked environment files, runtime artifacts, provider approval gates, all locked dependency licenses and valid SRI integrity values, plus full-commit pinning for workflow actions and reusable workflows. Pattern scanning is not a substitute for provider-side secret scanning, a current registry vulnerability audit, customer privacy review or legal review of exact asset redistribution rights.

Sharp may install platform-specific libvips packages licensed under `LGPL-3.0-or-later`, sometimes alongside Apache-2.0/MIT components. Before redistributing a package or container that includes those binaries, preserve required notices and have the exact distribution method reviewed for LGPL source/relocation and other license obligations. Passing the allowlist is inventory evidence, not legal advice.

## Viewer

The bundled server is intended for local review. It permits GET/HEAD only, verifies lexical and real-path containment and sends restrictive browser security headers. Public deployment still requires maintained HTTPS termination, authentication, upload limits, access control, monitoring and retention policy.

## Release integrity

Candidate and production packages contain a CycloneDX SBOM, artifact SHA-256 and hashed release manifest. Production release additionally requires:

- clean source state;
- passing security and release doctor;
- Linux, macOS and Windows evidence for the same commit;
- actual desktop, mobile, XR and Blender reports;
- an interactively accepted anonymized real project;
- matching formal version tag.

Qualification records embed their complete bounded JSON and hashes, but hashes do not authenticate a physical device or human event by themselves. Release owners must obtain platform records from the actual GitHub run, retain raw device/renderer captures externally, and verify the interactive real-project acceptance. The protected qualification secret transports evidence for an already fixed commit; it must never contain customer source material or credentials.

Never treat a candidate artifact with `release_ready: false` as a production release.
