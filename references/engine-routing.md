# Engine routing

Read this reference when selecting a stack or entering a project whose engine is unfamiliar.

## Choose by project context

| Context | Prefer | Notes |
|---|---|---|
| Existing web app with custom rendering | Three.js or the project's current wrapper | Keep the scene lifecycle integrated with the app framework. |
| React application | React Three Fiber when already present | Do not introduce it solely to wrap a small existing Three.js scene. |
| Data-driven web scene with engine services | Babylon.js when already present or explicitly selected | Use its native XR, asset, and input abstractions consistently. |
| Declarative prototype or learning demo | A-Frame | Keep custom components small and isolate low-level Three.js access. |
| Standalone headset or multi-platform native app | Unity XR or the existing Unity stack | Follow the installed XR provider and interaction toolkit versions. |
| High-fidelity native simulation | Unreal with OpenXR | Preserve the project's input actions, pawn, and rendering pipeline. |

## Apply shared constraints

- Confirm current engine and plugin versions from the project, not memory.
- Check current official documentation before adding APIs whose support or names may have changed.
- Use OpenXR or WebXR abstractions where they preserve target-device portability.
- Isolate vendor-only features behind capability checks and keep a portable fallback.
- Avoid adding a second scene framework or physics engine without a concrete requirement.

## Browser-specific notes

- Require a secure context for immersive WebXR.
- Start immersive sessions from a user gesture.
- Feature-detect session modes and optional features before requesting them.
- Keep canvas-based desktop controls usable when immersive mode is unavailable.
- Dispose renderers, sessions, event listeners, geometries, materials, and textures during teardown.

## Native-engine notes

- Verify the active XR provider, render pipeline, target SDK, and input action setup before editing project settings.
- Avoid upgrading engine or XR packages as an incidental change.
- Keep platform entitlements and manifests minimal and document any new permission.
- Build and profile on target hardware before declaring the experience complete.
