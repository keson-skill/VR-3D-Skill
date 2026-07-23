# Spatial JSON contract

Use this contract as the authoritative, renderer-neutral representation of the interior. Implement a formal JSON Schema in the host project when the pipeline is automated.

## Contents

- [Required principles](#required-principles)
- [Minimal shape](#minimal-shape)
- [Provenance](#provenance)
- [Validation order](#validation-order)
- [Revision contract](#revision-contract)

## Required principles

- Use stable IDs and explicit references; never rely on array order.
- Declare schema version, units, axes, handedness, origin, and revision.
- Preserve measured values separately from inferred or generated values.
- Attach provenance and confidence to geometry or design facts that are not deterministic.
- Separate the immutable measured envelope from editable design objects.
- Mark structural roles and edit policies explicitly; never infer that an exterior-looking wall is safe to modify.
- Store user constraints and design intent separately from extracted spatial facts.
- Bind room surfaces and asset material slots to stable material IDs.
- Represent clearances and circulation as constraints, not just visual overlays.
- Keep renderer-specific values in `render_profiles` or sidecar files.

## Minimal shape

```json
{
  "schema_version": "1.0",
  "project": {
    "id": "project-001",
    "revision": "rev-001",
    "units": "meters",
    "up_axis": "Y",
    "forward_axis": "-Z",
    "handedness": "right",
    "origin": [0, 0, 0]
  },
  "sources": [
    {
      "id": "source-plan-01",
      "type": "dimensioned_floor_plan",
      "uri": "local://redacted",
      "revision": "A",
      "contains_personal_data": false
    }
  ],
  "requirements": {
    "design_intent": {
      "style": "warm cream",
      "scope_ids": ["room-living"]
    },
    "constraints": [
      {
        "id": "constraint-preserve-wall-01",
        "kind": "preserve_structure",
        "target_ids": ["wall-01"],
        "priority": "must"
      }
    ]
  },
  "envelope": {
    "floor_elevation": 0,
    "ceiling_height": 2.8,
    "walls": [
      {
        "id": "wall-01",
        "start": [0, 0],
        "end": [4.2, 0],
        "thickness": 0.2,
        "height": 2.8,
        "structural_role": "load_bearing",
        "edit_policy": "locked",
        "provenance": {
          "source_id": "source-plan-01",
          "method": "measured",
          "confidence": 0.99
        }
      },
      {
        "id": "wall-02",
        "start": [4.2, 0],
        "end": [4.2, 6.0],
        "thickness": 0.15,
        "height": 2.8,
        "structural_role": "unknown",
        "edit_policy": "review_required"
      },
      {
        "id": "wall-03",
        "start": [4.2, 6.0],
        "end": [0, 6.0],
        "thickness": 0.2,
        "height": 2.8,
        "structural_role": "unknown",
        "edit_policy": "review_required"
      },
      {
        "id": "wall-04",
        "start": [0, 6.0],
        "end": [0, 0],
        "thickness": 0.15,
        "height": 2.8,
        "structural_role": "unknown",
        "edit_policy": "review_required"
      }
    ],
    "openings": [
      {
        "id": "door-01",
        "kind": "hinged_door",
        "host_wall_id": "wall-01",
        "offset": 0.75,
        "width": 0.9,
        "height": 2.1,
        "sill_height": 0,
        "swing": {
          "hinge": "start",
          "direction": "inward",
          "angle_degrees": 90
        }
      }
    ]
  },
  "rooms": [
    {
      "id": "room-living",
      "name": "Living room",
      "type": "living",
      "boundary_wall_ids": ["wall-01", "wall-02", "wall-03", "wall-04"],
      "area": 25.2,
      "functions": ["conversation", "media", "circulation"],
      "constraints": ["preserve_balcony_route"]
    }
  ],
  "circulation": {
    "minimum_clearance": 0.9,
    "paths": [
      {
        "id": "path-entry-living",
        "purpose": "primary",
        "polyline": [[1.2, 0.5], [1.2, 5.5]],
        "minimum_width": 0.9,
        "must_remain_clear": true
      }
    ]
  },
  "design_objects": [
    {
      "id": "furniture-sofa-01",
      "kind": "sofa",
      "room_id": "room-living",
      "transform": {
        "position": [2.1, 0, 1.0],
        "rotation_euler_degrees": [0, 180, 0],
        "scale": [1, 1, 1]
      },
      "dimensions": [2.2, 0.85, 0.95],
      "clearance_zones": [
        {
          "side": "front",
          "depth": 0.6
        }
      ],
      "asset_id": "asset-sofa-01",
      "placement_status": "validated"
    }
  ],
  "assets": [
    {
      "id": "asset-sofa-01",
      "uri": "assets/sofa-01.glb",
      "format": "glb",
      "source": "generated",
      "generator": "configured_hunyuan3d_model",
      "license": "verify_before_distribution",
      "dimensions": [2.2, 0.85, 0.95],
      "pivot": "bottom_center",
      "forward_axis": "-Z",
      "optimized": true
    }
  ],
  "surfaces": [
    {
      "id": "surface-wall-01-living",
      "host_id": "wall-01",
      "room_id": "room-living",
      "side": "interior",
      "material_id": "wall_main",
      "edit_policy": "style_editable"
    }
  ],
  "materials": {
    "wall_main": {
      "base_color": "#E7E0D5",
      "roughness": 0.72,
      "metalness": 0
    }
  },
  "lights": [
    {
      "id": "light-main",
      "kind": "area",
      "position": [2.1, 2.65, 2.4],
      "intensity": 500,
      "color_temperature_kelvin": 3000
    }
  ],
  "xr": {
    "spawn": [1.0, 0, 1.0],
    "spawn_yaw_degrees": 0,
    "navigation": "teleport",
    "snap_turn_degrees": 30,
    "boundary_room_ids": ["room-living"]
  },
  "render_profiles": {
    "webxr": {
      "quality_tier": "balanced",
      "target_asset_format": "glb"
    }
  },
  "assumptions": [],
  "unresolved_questions": [],
  "validation": {
    "status": "pending",
    "checks": []
  }
}
```

The example shows one internally connected room, not a complete building model. A validator must still reject incomplete geometry, dangling references, unknown structural roles presented as facts, or constraints that target missing IDs rather than filling them silently.

## Provenance

For important facts, record:

- `source_id` and source revision;
- method: `measured`, `parsed`, `observed`, `inferred`, `generated`, or `user_edited`;
- confidence from `0` to `1` when uncertainty exists;
- model and provider only when a model produced the fact;
- timestamp and project revision in the host system when audit history is required.

Do not treat model confidence as dimensional tolerance. Store tolerances separately and derive them from source quality or project requirements.

## Validation order

1. JSON syntax and schema.
2. IDs, references, enums, units, axes, and transforms.
3. Wall and room topology.
4. Dimensions, source agreement, and tolerances.
5. Openings, swings, fixed services, and unusable zones.
6. Furniture bounds, collision, clearances, and circulation.
7. Asset scale, pivot, materials, license, and provenance.
8. XR spawn, navigation boundaries, reach, and comfort defaults.
9. Renderer adapter and performance budgets.

## Revision contract

Every edit should include:

- unique revision ID and base revision;
- human intent;
- explicit operations;
- exact stable IDs and exact JSON Pointer paths that must be preserved;
- affected artifacts;
- validations to rerun;
- author or model provenance;
- rollback reference.

Use RFC 6901 JSON Pointer for `path`. Allow operations only on object keys or ID-keyed maps when a stable path exists. For array members, use `target_id` plus a relative `field_path`; do not use array indexes or wildcards in durable revisions. Store preservation rules separately as `must_preserve_ids` and `must_preserve_paths`.

```json
{
  "revision_id": "rev-002",
  "base_revision": "rev-001",
  "intent": "Change only the living-room wall finish to dark walnut.",
  "operations": [
    {
      "op": "add",
      "path": "/materials/wall_walnut_dark",
      "value": {
        "base_color": "#3B2418",
        "roughness": 0.55,
        "metalness": 0
      }
    },
    {
      "op": "replace",
      "target_id": "surface-wall-01-living",
      "field_path": "/material_id",
      "value": "wall_walnut_dark"
    }
  ],
  "must_preserve_ids": ["wall-01", "door-01", "furniture-sofa-01"],
  "must_preserve_paths": [
    "/envelope",
    "/rooms",
    "/circulation",
    "/design_objects"
  ],
  "revalidate": ["materials", "lighting", "asset_material_bindings", "performance"]
}
```

Reject a patch when its base revision is stale, a target ID is missing, a pointer is invalid, or a preserved constraint would be violated. Prefer targeted regeneration over recreating unrelated rooms or assets.
