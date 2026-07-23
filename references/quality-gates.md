# Quality gates

Use the gates that apply to the requested platform. Record any gate that cannot be verified.

## Functional

- The experience enters and exits immersive mode cleanly.
- The primary task works with each required input method.
- Lost tracking, missing controllers, and denied session startup fail safely.
- Re-entering a session does not duplicate listeners, objects, or update loops.
- Desktop or mobile fallback controls are discoverable and usable.

## Spatial

- World scale is credible and consistent.
- The initial view, floor, and interaction reach match the intended user posture.
- UI remains legible without requiring extreme neck rotation or arm extension.
- Teleport targets and boundaries clearly distinguish valid and invalid space.

## Comfort

- Teleport and snap turn are available when artificial locomotion is required.
- Smooth movement, rotation speed, vignette, dominant hand, and seated or standing mode are configurable when relevant.
- The application does not force camera motion, roll the horizon, or apply head bob.
- Rapid flashes, large close motion, and sudden spatial audio changes are avoided.

## Performance

- Frame time is measured on representative target hardware.
- No steady per-frame memory growth is observed during normal interaction.
- Draw calls, visible triangles, shader cost, texture memory, and transparent overdraw are reviewed.
- Loading is progressive and includes visible feedback and recoverable errors.
- Unused GPU and event resources are released on teardown.

## Accessibility and fallback

- Important state is communicated by more than color alone.
- Controls provide visible focus and activation feedback.
- Audio-dependent actions have visual or haptic equivalents when practical.
- Flat-screen mode supports keyboard and pointer input for the primary task.
- Safety, boundary, and exit controls remain easy to reach.

## Test matrix

| Area | Minimum evidence |
|---|---|
| Desktop fallback | Launch, navigate, complete the primary task, and recover from XR unavailability |
| Immersive lifecycle | Enter, exit, re-enter, pause, resume, and lose focus |
| Input | Select, cancel, grab or manipulate, locomote, and reconnect |
| Spatial setup | Standing or seated origin, floor height, handedness, and reach |
| Performance | Representative device frame-time capture during the busiest scene |
| Failure handling | Asset failure, denied permission, unsupported feature, and disconnected input |
