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
        raise RuntimeError("Usage: blender ... -- source_file output.glb [target_size]")
    target_size = float(values[2]) if len(values) == 3 else 1.0
    if target_size <= 0:
        raise ValueError("target_size must be greater than zero")
    return os.path.abspath(values[0]), os.path.abspath(values[1]), target_size


def supported_operator_args(operator, candidates):
    supported = {prop.identifier for prop in operator.get_rna_type().properties}
    return {key: value for key, value in candidates.items() if key in supported}


def supported_enum_value(operator, property_name, candidates):
    properties = operator.get_rna_type().properties
    prop = next(
        (item for item in properties if item.identifier == property_name), None
    )
    if prop is None:
        return None
    supported = {item.identifier for item in prop.enum_items}
    return next((candidate for candidate in candidates if candidate in supported), None)


def call_operator(category, name, **kwargs):
    group = getattr(bpy.ops, category, None)
    operator = getattr(group, name, None) if group else None
    if operator is None:
        raise RuntimeError(
            f"Blender {bpy.app.version_string} does not provide importer {category}.{name}"
        )
    result = operator(**kwargs)
    if "FINISHED" not in result:
        raise RuntimeError(f"Importer {category}.{name} failed: {result}")
    return f"{category}.{name}"


def first_available_operator(candidates, **kwargs):
    errors = []
    for category, name in candidates:
        try:
            return call_operator(category, name, **kwargs)
        except RuntimeError as error:
            errors.append(str(error))
    raise RuntimeError("No compatible Blender importer is available. " + " | ".join(errors))


def import_source(input_path):
    extension = os.path.splitext(input_path)[1].lower()
    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=input_path)
        return "wm.open_mainfile"

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if extension in (".glb", ".gltf"):
        return call_operator("import_scene", "gltf", filepath=input_path)
    if extension == ".fbx":
        return call_operator("import_scene", "fbx", filepath=input_path)
    if extension == ".dae":
        return call_operator("wm", "collada_import", filepath=input_path)
    if extension == ".obj":
        return first_available_operator(
            [("wm", "obj_import"), ("import_scene", "obj")], filepath=input_path
        )
    if extension == ".stl":
        return first_available_operator(
            [("wm", "stl_import"), ("import_mesh", "stl")], filepath=input_path
        )
    if extension == ".ply":
        return first_available_operator(
            [("wm", "ply_import"), ("import_mesh", "ply")], filepath=input_path
        )
    if extension == ".3mf":
        return first_available_operator(
            [
                ("wm", "threemf_import"),
                ("import_mesh", "threemf"),
                ("import_scene", "threemf"),
            ],
            filepath=input_path,
        )
    if extension == ".usdz":
        return call_operator("wm", "usd_import", filepath=input_path)
    raise RuntimeError(f"Unsupported source extension: {extension or 'missing'}")


def configure_animations():
    ranges = [action.frame_range for action in bpy.data.actions if action.frame_range]
    if ranges:
        bpy.context.scene.frame_start = int(min(item[0] for item in ranges))
        bpy.context.scene.frame_end = int(max(item[1] for item in ranges))

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
        raise RuntimeError("Imported source does not contain mesh bounds")

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
        raise RuntimeError("Imported source has empty bounds")

    root = bpy.data.objects.new("ModelSpaceCanonicalRoot", None)
    bpy.context.scene.collection.objects.link(root)
    top_level = [
        item for item in bpy.context.scene.objects if item != root and item.parent is None
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
        "targetSize": target_size,
        "scale": scale,
        "topLevelObjects": len(top_level),
    }


def main():
    input_path, output_path, target_size = arguments()
    if not os.path.isfile(input_path):
        raise FileNotFoundError(input_path)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    importer = import_source(input_path)
    mesh_objects = [item for item in bpy.context.scene.objects if item.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError("Imported source does not contain any mesh objects")

    nla_tracks, nla_strips = configure_animations()
    normalization = normalize_model_size(target_size)
    export_args = supported_operator_args(
        bpy.ops.export_scene.gltf,
        {
            "filepath": output_path,
            "export_format": "GLB",
            "use_selection": False,
            "export_animations": True,
            "export_nla_strips": True,
            "export_force_sampling": True,
            "export_skins": True,
            "export_morph": True,
            "export_materials": "EXPORT",
            "export_cameras": False,
            "export_lights": False,
            "export_apply": False,
        },
    )
    animation_mode = supported_enum_value(
        bpy.ops.export_scene.gltf,
        "export_animation_mode",
        ["ACTIONS", "NLA_TRACKS", "ACTIVE_ACTIONS"],
    )
    if animation_mode:
        export_args["export_animation_mode"] = animation_mode
    export_args["filepath"] = output_path
    export_args["export_format"] = "GLB"
    result = bpy.ops.export_scene.gltf(**export_args)
    if "FINISHED" not in result:
        raise RuntimeError(f"GLB export failed: {result}")

    armatures = [item for item in bpy.context.scene.objects if item.type == "ARMATURE"]
    print(
        "MODELSPACE_RESULT="
        + json.dumps(
            {
                "input": input_path,
                "output": output_path,
                "importer": importer,
                "meshes": len(mesh_objects),
                "armatures": len(armatures),
                "actions": len(bpy.data.actions),
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
