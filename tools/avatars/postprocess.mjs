// Clean up a Blender-exported Rocketbox avatar before texture compression.
//   node postprocess.mjs <in.glb> <out.glb> <id>
// - drops FBX vertex colours (three.js would multiply them into the albedo)
// - matte, single-sided skin and cloth; hair, lashes and glasses alpha-tested (MASK 0.5), double-sided
// - removes KHR_materials_specular and unused data
// - names meshes, materials and textures predictably
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, sparse } from '@gltf-transform/functions';

const [input, output, id] = process.argv.slice(2);
if (!input || !output || !id) {
  console.error('usage: node postprocess.mjs <in.glb> <out.glb> <id>');
  process.exit(2);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();

for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'KHR_materials_specular') ext.dispose();
}

for (const mesh of root.listMeshes()) {
  mesh.setName(id);
  for (const prim of mesh.listPrimitives()) {
    for (const semantic of prim.listSemantics()) {
      if (semantic.startsWith('COLOR_')) prim.setAttribute(semantic, null);
    }
  }
}

// Blender exports any material with a linked alpha as BLEND; those are hair, lashes and glasses.
const isCutout = (mat) => mat.getAlphaMode() !== 'OPAQUE' || /opacity/i.test(mat.getName());
for (const mat of root.listMaterials()) {
  const name = mat.getName();
  mat.setMetallicFactor(0).setRoughnessFactor(0.65);
  mat.setMetallicRoughnessTexture(null);
  if (isCutout(mat)) {
    mat.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true);
  } else {
    mat.setAlphaMode('OPAQUE').setDoubleSided(false);
  }
  const color = mat.getBaseColorTexture();
  if (color) color.setName(`${name}_color`);
  const normal = mat.getNormalTexture();
  if (normal) normal.setName(`${name}_normal`);
}

await doc.transform(dedup(), sparse({ ratio: 1 / 3 }), prune());
await io.write(output, doc);

const mesh = root.listMeshes()[0];
console.log(
  'POST_OK',
  JSON.stringify({
    id,
    materials: root.listMaterials().map((m) => `${m.getName()}:${m.getAlphaMode()}`),
    textures: root.listTextures().map((t) => t.getName()),
    morphs: (mesh.getExtras().targetNames ?? []).length,
  }),
);
