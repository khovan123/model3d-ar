import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync
} from "three/addons/libs/fflate.module.js";

const PLAQUE_NAME = "__modelspace_quicklook_plaque__";

type USDZExporterPrototype = USDZExporter & {
  __modelSpaceQuickLookFinalizePatch?: boolean;
};

type MaterialSnapshot = {
  material: THREE.MeshStandardMaterial;
  emissive: THREE.Color;
  emissiveMap: THREE.Texture | null;
  emissiveIntensity: number;
};

function alignAndZip(files: Record<string, Uint8Array>) {
  const orderedEntries = Object.entries(files).sort(([a], [b]) => {
    if (a === "model.usda") return -1;
    if (b === "model.usda") return 1;
    return 0;
  });

  const aligned: Record<
    string,
    Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }]
  > = {};
  let offset = 0;

  for (const [filename, file] of orderedEntries) {
    const headerSize = 34 + filename.length;
    offset += headerSize;
    const offsetMod64 = offset & 63;

    if (offsetMod64 !== 4) {
      aligned[filename] = [
        file,
        { extra: { 12345: new Uint8Array(64 - offsetMod64) } }
      ];
    } else {
      aligned[filename] = file;
    }

    offset = file.length;
  }

  return zipSync(aligned, { level: 0 });
}

function installMaterialTextureFallback(scene: THREE.Object3D) {
  const snapshots: MaterialSnapshot[] = [];
  const seen = new Set<THREE.MeshStandardMaterial>();
  let texturedMaterialCount = 0;

  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    for (const candidate of materials) {
      if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
      if (!candidate.map || seen.has(candidate)) continue;
      seen.add(candidate);
      texturedMaterialCount += 1;

      candidate.map.colorSpace = THREE.SRGBColorSpace;
      candidate.map.needsUpdate = true;

      // Quick Look has historically been more reliable with an explicit
      // emissive texture path than with some GLB diffuse-material combinations.
      // Keep the original PBR diffuse map and mirror it into emissive only as a
      // low-intensity compatibility fallback on the temporary USDZ export scene.
      if (!candidate.emissiveMap) {
        snapshots.push({
          material: candidate,
          emissive: candidate.emissive.clone(),
          emissiveMap: candidate.emissiveMap,
          emissiveIntensity: candidate.emissiveIntensity
        });
        candidate.emissive.set(0xffffff);
        candidate.emissiveMap = candidate.map;
        candidate.emissiveIntensity = Math.max(candidate.emissiveIntensity, 0.28);
        candidate.needsUpdate = true;
      }
    }
  });

  if (texturedMaterialCount > 0) {
    console.info(
      `[ModelSpace] Preparing ${texturedMaterialCount} textured material(s) for Quick Look USDZ.`
    );
  }

  return () => {
    for (const snapshot of snapshots) {
      snapshot.material.emissive.copy(snapshot.emissive);
      snapshot.material.emissiveMap = snapshot.emissiveMap;
      snapshot.material.emissiveIntensity = snapshot.emissiveIntensity;
      snapshot.material.needsUpdate = true;
    }
  };
}

function setPlaqueInitiallyHidden(usda: string) {
  const lines = usda.split("\n");
  const plaqueDefinition = lines.findIndex((line) =>
    line.includes(`def Xform "${PLAQUE_NAME}"`) ||
    line.includes(`def "${PLAQUE_NAME}"`)
  );
  if (plaqueDefinition < 0) return usda;

  const definitionIndent = lines[plaqueDefinition].match(/^(\s*)/)?.[1] ?? "";
  let openBrace = -1;
  let closeBrace = -1;

  for (let index = plaqueDefinition; index < lines.length; index += 1) {
    if (openBrace < 0 && lines[index].trim() === "{") {
      openBrace = index;
      continue;
    }
    if (openBrace >= 0 && lines[index] === `${definitionIndent}}`) {
      closeBrace = index;
      break;
    }
  }

  if (openBrace < 0 || closeBrace < 0) return usda;

  const alreadyAuthored = lines
    .slice(openBrace + 1, closeBrace)
    .some((line) => /\bvisibility\s*=/.test(line));
  if (alreadyAuthored) return usda;

  lines.splice(
    openBrace + 1,
    0,
    `${definitionIndent}\ttoken visibility = "invisible"`
  );
  return lines.join("\n");
}

function auditTextureAssets(usda: string, files: Record<string, Uint8Array>) {
  const textureReferences = Array.from(
    usda.matchAll(/asset\s+inputs:file\s*=\s*@([^@]+)@/g),
    (match) => match[1]
  ).filter((path) => path.startsWith("textures/"));

  const uniqueReferences = Array.from(new Set(textureReferences));
  const missing = uniqueReferences.filter((path) => !files[path]);

  console.info(
    `[ModelSpace] Quick Look USDZ contains ${uniqueReferences.length} texture reference(s); missing=${missing.length}.`
  );
  if (missing.length > 0) {
    console.warn("[ModelSpace] Missing USDZ texture assets:", missing);
  }
}

function finalizeUsdArchive(buffer: Uint8Array<ArrayBuffer>) {
  try {
    const files = unzipSync(buffer);
    const modelFile = files["model.usda"];
    if (!modelFile) return buffer;

    const original = strFromU8(modelFile);
    const next = setPlaqueInitiallyHidden(original);
    auditTextureAssets(next, files);

    if (next === original) return buffer;
    files["model.usda"] = strToU8(next);
    console.info("[ModelSpace] Quick Look info plaque authored hidden until model tap.");
    return alignAndZip(files);
  } catch (error) {
    console.warn("[ModelSpace] Unable to finalize Quick Look USDZ; using previous archive.", error);
    return buffer;
  }
}

export function installQuickLookUsdFinalizePatch() {
  const prototype = USDZExporter.prototype as USDZExporterPrototype;
  if (prototype.__modelSpaceQuickLookFinalizePatch) return;
  prototype.__modelSpaceQuickLookFinalizePatch = true;

  const originalParseAsync = USDZExporter.prototype.parseAsync;
  USDZExporter.prototype.parseAsync = async function (scene, options) {
    const restoreMaterials = installMaterialTextureFallback(scene);
    try {
      const output = await originalParseAsync.call(this, scene, options);
      return finalizeUsdArchive(output);
    } finally {
      restoreMaterials();
    }
  };
}
