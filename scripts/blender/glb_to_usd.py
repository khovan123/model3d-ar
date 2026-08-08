import json
import os
import sys

import bpy
from mathutils import Vector


def arguments():
    argv = sys.argv
    if "--" not in argv:
        raise RuntimeError("Expected input and output paths after --")
    values = argv[argv.index("--") + 1 :]
    if len(values) not in (2, 3):
        raise RuntimeError("Usage: blender ... -- input.glb output.usdc [target_size_meters]")
    target_size = float(values[2]) if len(values) == 3 else 0.32
    if target_size <= 0:
        raise ValueError("target_size_meters must be greater than zero")
    return os.path.abspath(values[0]), os.path.abspath(values[1]), target_size


def supported_operator_args(operator, candidates):
    supported = {prop.identifier for prop in operator.get_rna_type().properties}
    return {key: value for key, value in candidates.items() if key in supported}


def configure_frame_range():
    ranges = [action.frame_range for action in bpy.data.actions if action.frame_range]
    if not ranges:
        return
    bpy.context.scene.frame_start = int(min(item[0] for item in ranges))
    bpy.context.scene.frame_end = int(max(item[1] for item in ranges))


def activate_all_animation_tracks():
    tracks = 0
    strips = 0
    for item in bpy.data.objects:
        animation_data = item.animation_data
        if not animation_data:
            continue
        for track in animation_data.nla_tracks:
            track.mute = False
            tracks += 1
            for strip in track.strips:
                strip.mute = False
                strip.influence = 1.0
                strips += 1
    return tracks, strips


def normalize_model_size(target_size):
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)
    bpy.context.view_layer.update()

    points = []
    for item in bpy.context.scene.objects:
        if item.type != "MESH":
            continue
        points.extend(item.matrix_world @ Vector(corner) for corner in item.bound_box)
    if not points:
        raise RuntimeError("Imported GLB does not contain mesh bounds")

    minimum = Vector(
        (
            min(point.x for point in points),
            min(point.y for point in points),
            min(point.z for point in points),
        )
    )
    maximum = Vector(
        (
            max(point.x for point in points),
            max(point.y for point in points),
            max(point.z for point in points),
        )
    )
    size = maximum - minimum
    largest = max(size.x, size.y, size.z)
    if largest <= 0:
        raise RuntimeError("Imported GLB has empty bounds")

    root = bpy.data.objects.new("ModelSpaceRoot", None)
    bpy.context.scene.collection.objects.link(root)
    top_level = [
        item
        for item in bpy.context.scene.objects
        if item != root and item.parent is None
    ]
    for item in top_level:
        world_matrix = item.matrix_world.copy()
        item.parent = root
        item.matrix_world = world_matrix

    scale = target_size / largest
    center = (minimum + maximum) * 0.5
    root.scale = (scale, scale, scale)
    root.location = (-center.x * scale, -minimum.y * scale, -center.z * scale)
    bpy.context.view_layer.update()
    return {
        "sourceSize": [size.x, size.y, size.z],
        "targetSizeMeters": target_size,
        "scale": scale,
        "topLevelObjects": len(top_level),
    }


def main():
    input_path, output_path, target_size = arguments()
    if not os.path.isfile(input_path):
        raise FileNotFoundError(input_path)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=input_path)
    configure_frame_range()
    nla_tracks, nla_strips = activate_all_animation_tracks()
    normalization = normalize_model_size(target_size)

    export_args = supported_operator_args(
        bpy.ops.wm.usd_export,
        {
            "filepath": output_path,
            "selected_objects_only": False,
            "visible_objects_only": False,
            "export_animation": True,
            "export_hair": False,
            "export_uvmaps": True,
            "export_normals": True,
            "export_materials": True,
            "export_textures": True,
            "relative_paths": True,
            "export_armatures": True,
            "export_shapekeys": True,
            "evaluation_mode": "RENDER",
        },
    )
    export_args["filepath"] = output_path
    result = bpy.ops.wm.usd_export(**export_args)
    if "FINISHED" not in result:
        raise RuntimeError(f"USD export failed: {result}")

    armatures = sum(1 for item in bpy.data.objects if item.type == "ARMATURE")
    animated_actions = len(bpy.data.actions)
    print(
        "MODELSPACE_RESULT="
        + json.dumps(
            {
                "output": output_path,
                "armatures": armatures,
                "actions": animated_actions,
                "nlaTracks": nla_tracks,
                "nlaStrips": nla_strips,
                "normalization": normalization,
                "frameStart": bpy.context.scene.frame_start,
                "frameEnd": bpy.context.scene.frame_end,
                "exportOptions": sorted(export_args.keys()),
            }
        )
    )


if __name__ == "__main__":
    main()
