import json
import os
import sys
from datetime import datetime, timezone

import bpy
from mathutils import Vector


def look_at(camera, target):
    direction = Vector(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def write_checkpoint(path, state, detail=None):
    history = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as existing:
                history = json.load(existing).get("history", [])
        except (OSError, ValueError):
            history = []
    event = {
        "state": state,
        "detail": detail,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    history.append(event)
    payload = {**event, "history": history[-50:]}
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def set_color_management(scene, settings):
    scene.view_settings.view_transform = settings["view_transform"]
    preferred = settings["look"]
    for look in (preferred, preferred.replace("AgX - ", ""), "None"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    scene.view_settings.exposure = settings["exposure"]
    scene.view_settings.gamma = settings["gamma"]


def render_walkthrough(scene, camera_specs, plan, output):
    walkthrough = plan["optional_walkthrough"]
    if not walkthrough["enabled"]:
        return
    write_checkpoint(
        os.path.join(output, plan["checkpoint_file"]),
        "rendering_walkthrough",
    )
    camera_data = bpy.data.cameras.new("walkthrough")
    camera = bpy.data.objects.new("walkthrough", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    frames_per_view = walkthrough["frames_per_view"]
    for index, camera_spec in enumerate(camera_specs):
        frame = 1 + index * frames_per_view
        camera.location = camera_spec["position"]
        look_at(camera, camera_spec["target"])
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
    scene.frame_start = 1
    scene.frame_end = max(1, 1 + (len(camera_specs) - 1) * frames_per_view)
    scene.render.fps = walkthrough["fps"]
    scene.render.resolution_x = walkthrough["width"]
    scene.render.resolution_y = walkthrough["height"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = walkthrough["format"]
    scene.render.ffmpeg.codec = walkthrough["codec"]
    scene.render.filepath = os.path.join(output, walkthrough["file"])
    os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
    bpy.ops.render.render(animation=True)


def main(config_path):
    with open(config_path, encoding="utf-8") as handle:
        plan = json.load(handle)
    output = os.path.abspath(plan["output_directory"])
    os.makedirs(output, exist_ok=True)
    checkpoint = os.path.join(output, plan["checkpoint_file"])
    write_checkpoint(checkpoint, "importing")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(plan["source_scene"]))
    scene = bpy.context.scene
    scene.render.engine = plan["engine"]
    set_color_management(scene, plan["color_management"])
    camera_map = {}
    for camera_spec in plan["cameras"]:
        data = bpy.data.cameras.new(camera_spec["id"])
        camera = bpy.data.objects.new(camera_spec["id"], data)
        scene.collection.objects.link(camera)
        camera.location = camera_spec["position"]
        look_at(camera, camera_spec["target"])
        camera_map[camera_spec["id"]] = camera
    write_checkpoint(checkpoint, "rendering_stills")
    for still in plan["stills"]:
        scene.camera = camera_map[still["camera_id"]]
        scene.render.resolution_x = still["width"]
        scene.render.resolution_y = still["height"]
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = still["format"]
        scene.render.filepath = os.path.join(output, still["file"])
        os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
        bpy.ops.render.render(write_still=True)
    panorama = plan["panorama"]
    pano_camera = camera_map[panorama["camera_id"]]
    pano_camera.data.type = "PANO"
    pano_camera.data.panorama_type = "EQUIRECTANGULAR"
    scene.camera = pano_camera
    scene.render.resolution_x = panorama["width"]
    scene.render.resolution_y = panorama["height"]
    scene.render.filepath = os.path.join(output, panorama["file"])
    os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
    write_checkpoint(checkpoint, "rendering_panorama")
    bpy.ops.render.render(write_still=True)
    render_walkthrough(scene, plan["cameras"], plan, output)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, plan["blend_file"]))
    write_checkpoint(checkpoint, "completed", {"plan_sha256": plan["plan_sha256"]})


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 1:
        raise SystemExit("Usage: blender --background --python render_scene.py -- render-plan.json")
    try:
        main(args[0])
    except Exception as error:
        try:
            with open(args[0], encoding="utf-8") as handle:
                plan = json.load(handle)
            output = os.path.abspath(plan["output_directory"])
            os.makedirs(output, exist_ok=True)
            write_checkpoint(
                os.path.join(output, plan["checkpoint_file"]),
                "failed",
                {"error_type": type(error).__name__},
            )
        finally:
            raise
