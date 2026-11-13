"""Convert Rocketbox FBX files to glTF binaries (Blender 4.2 LTS, headless).

Avatar mode (skinned mesh, renamed face shapes, no animation):
    blender -b --factory-startup -P rb2glb.py -- avatar <in_facial.fbx> <textures_dir> <out.glb> <info.json>

Clip mode (armature only, one action named <clip_name>):
    blender -b --factory-startup -P rb2glb.py -- clip <in_anim.fbx> <clip_name> <out.glb>

Avatar mode keeps the ARKit shapes listed in KEEP_ARKIT plus all 15 Oculus visemes and renames them
to the names three.js code uses (`jawOpen`, `viseme_aa`, ...). All other shape keys (FACS, Vive and
the rest) are removed. The mapping is written to <info.json> together with height and bone names.
"""

import json
import os
import re
import sys

import bpy

# Oculus viseme names, keyed by the Rocketbox suffix of `AA_VI_<nn>_<suffix>`.
VISEMES = {
    "Sil": "viseme_sil", "PP": "viseme_PP", "FF": "viseme_FF", "TH": "viseme_TH",
    "DD": "viseme_DD", "KK": "viseme_kk", "CH": "viseme_CH", "SS": "viseme_SS",
    "nn": "viseme_nn", "RR": "viseme_RR", "aa": "viseme_aa", "E": "viseme_E",
    "I": "viseme_I", "O": "viseme_O", "U": "viseme_U",
}

# ARKit shapes we keep: brows, eyes, jaw and mouth for lip sync and expressions.
# Dropped: cheekPuff, jawLeft, jawRight, mouthLeft, mouthRight, noseSneerLeft, noseSneerRight, tongueOut.
KEEP_ARKIT = [
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekSquintLeft", "cheekSquintRight",
    "eyeBlinkLeft", "eyeBlinkRight",
    "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
    "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
    "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
    "jawForward", "jawOpen",
    "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight",
    "mouthFunnel", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight",
    "mouthPucker", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
    "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthUpperUpLeft", "mouthUpperUpRight",
]

ARKIT_RE = re.compile(r"^AK_\d\d_(\w+)$")
VISEME_RE = re.compile(r"^AA_VI_\d\d_(\w+)$")


def args():
    return sys.argv[sys.argv.index("--") + 1:]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path, anim):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=anim, automatic_bone_orientation=False)
    return [o for o in bpy.data.objects if o not in before]


def relink_textures(tex_dir):
    """FBX files store absolute Windows paths; point every image at the local Textures folder."""
    missing = []
    for img in bpy.data.images:
        name = os.path.basename(img.filepath.replace("\\", "/"))
        local = os.path.join(tex_dir, name)
        if os.path.exists(local):
            img.filepath = local
            img.reload()
        elif name:
            missing.append(name)
    return missing


def rename_shape_keys(mesh_obj):
    """Rename kept keys to ARKit / Oculus names, remove the rest. Returns {original: new}."""
    keys = mesh_obj.data.shape_keys
    mapping = {}
    for kb in list(keys.key_blocks)[1:]:
        original = kb.name
        ak = ARKIT_RE.match(original)
        vi = VISEME_RE.match(original)
        new = None
        if ak:
            candidate = ak[1][0].lower() + ak[1][1:]
            if candidate in KEEP_ARKIT:
                new = candidate
        elif vi and vi[1] in VISEMES:
            new = VISEMES[vi[1]]
        if new is None:
            mesh_obj.shape_key_remove(kb)
            continue
        kb.name = new
        mapping[original] = new
    return mapping


def fix_materials():
    """Matte skin and cloth: drop specular maps, no metal. Alpha handling is set after export."""
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = nodes.get("Principled BSDF")
        if not bsdf:
            continue
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 0.65
        for socket in ("Specular IOR Level", "Roughness", "Metallic"):
            for link in list(bsdf.inputs[socket].links):
                links.remove(link)
        # The FBX importer wires an image's Color into Alpha (the glasses do this). Rocketbox opacity
        # textures keep coverage in their alpha channel, so read Alpha from the image's alpha output.
        for link in list(bsdf.inputs["Alpha"].links):
            src = link.from_node
            if src.type == "TEX_IMAGE" and link.from_socket.name == "Color":
                links.remove(link)
                links.new(src.outputs["Alpha"], bsdf.inputs["Alpha"])
        for node in list(nodes):
            if node.type == "TEX_IMAGE" and not node.outputs["Color"].links and not node.outputs["Alpha"].links:
                nodes.remove(node)


def world_height(objs):
    from mathutils import Vector
    zs = []
    for o in objs:
        if o.type == "MESH":
            zs += [(o.matrix_world @ Vector(c)).z for c in o.bound_box]
    return max(zs) - min(zs)


def export_glb(out, animations):
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_apply=False,
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_frame_range=False,
        export_yup=True,
        export_extras=False,
        export_image_format="AUTO",
    )


def avatar(src, tex_dir, out, info_path):
    reset()
    objs = import_fbx(src, anim=False)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    missing = relink_textures(tex_dir)
    arm = next(o for o in objs if o.type == "ARMATURE")
    meshes = [o for o in objs if o.type == "MESH"]
    morphs = {}
    for m in meshes:
        if m.data.shape_keys:
            morphs.update(rename_shape_keys(m))
    fix_materials()
    height = world_height(meshes)
    info = {
        "armature": arm.name,
        "bones": [b.name for b in arm.data.bones],
        "meshes": [m.name for m in meshes],
        "tris": sum(len(p.vertices) - 2 for m in meshes for p in m.data.polygons),
        "verts": sum(len(m.data.vertices) for m in meshes),
        "materials": [mat.name for mat in bpy.data.materials],
        "height_m": round(height, 3),
        "morph_rename": morphs,
        "missing_textures": sorted(set(missing)),
    }
    export_glb(out, animations=False)
    with open(info_path, "w") as f:
        json.dump(info, f, indent=2)
    print("AVATAR_OK", json.dumps({k: info[k] for k in ("height_m", "tris", "verts")}))


def clip(src, name, out):
    reset()
    objs = import_fbx(src, anim=True)
    arm = next(o for o in objs if o.type == "ARMATURE")
    for o in objs:
        if o is not arm:
            bpy.data.objects.remove(o, do_unlink=True)
    act = arm.animation_data.action
    for other in list(bpy.data.actions):
        if other is not act:
            bpy.data.actions.remove(other)
    act.name = name
    start, end = act.frame_range
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = int(start), int(end)
    export_glb(out, animations=True)
    print("CLIP_OK", name, scene.render.fps, start, end)


if __name__ == "__main__":
    a = args()
    if a[0] == "avatar":
        avatar(*a[1:5])
    elif a[0] == "clip":
        clip(*a[1:4])
    else:
        raise SystemExit("usage: avatar|clip ...")
