# Engine routing

Read this reference when selecting a stack or entering a project whose engine is unfamiliar.

## Choose by deliverable

| Context or deliverable | Prefer | Notes |
|---|---|---|
| Browser review, shareable walkthrough, online WebXR | Three.js or the project's current wrapper | Keep `Spatial JSON` and scene configuration separate from rendering code. Export reusable assets as GLB. |
| Existing React application | React Three Fiber when already present | Do not introduce it solely to wrap a small existing Three.js scene. |
| Data-driven web scene with engine services | Babylon.js when already present or explicitly selected | Use its native XR, asset, input, and loading abstractions consistently. |
| Declarative prototype or learning demo | A-Frame | Keep custom components small and isolate low-level Three.js access. |
| Procedural scene assembly, geometry cleanup, baking, or offline renders | Blender Python | Generate deterministic scripts from approved scene data; do not encode the plan only in imperative code. |
| High-fidelity real-time presentation or simulation | Unreal with OpenXR | Preserve input actions, pawn, render pipeline, and source-controlled import settings. |
| Fast architectural visualization with an existing BIM or CAD flow | Twinmotion when explicitly available | Keep the validated spatial source and material mappings outside the presentation file. |
| Standalone headset or multi-platform native application | Unity XR or the existing Unity stack | Follow the installed XR provider and interaction toolkit versions. |

## Separate data from renderers

- Keep walls, openings, rooms, design objects, materials, lights, cameras, and navigation bounds addressable by stable IDs.
- Generate engine adapters from the same approved scene data instead of maintaining unrelated copies.
- Keep asset manifests and transform conventions renderer-neutral.
- Store renderer-specific overrides in a separate section or sidecar file.
- Never make an offline render the only evidence that a layout is spatially valid.

## Apply shared constraints

- Confirm current engine and plugin versions from the project, not memory.
- Check current official documentation before adding APIs whose support or names may have changed.
- Use OpenXR or WebXR abstractions where they preserve target-device portability.
- Isolate vendor-only features behind capability checks and keep a portable fallback.
- Avoid adding a second scene framework or physics engine without a concrete requirement.
- Keep meters, axes, handedness, forward direction, origins, and color-space conversions explicit at every import boundary.

## Browser-specific notes

- Require a secure context for immersive WebXR.
- Start immersive sessions from a user gesture.
- Feature-detect session modes and optional features before requesting them.
- Keep canvas-based desktop controls usable when immersive mode is unavailable.
- Dispose renderers, sessions, event listeners, geometries, materials, and textures during teardown.
- Prefer compressed GLB, KTX2 textures, Draco or Meshopt where supported, and quality-tiered assets.

## Native and offline-engine notes

- Verify the active XR provider, render pipeline, target SDK, input action setup, and import conventions before editing project settings.
- Avoid upgrading engines, XR packages, or render pipelines as an incidental change.
- Keep platform entitlements and manifests minimal and document any new permission.
- In Blender scripts, use stable collection names and object IDs, set units explicitly, and make reruns idempotent.
- Build and profile on target hardware before declaring a native experience complete.
