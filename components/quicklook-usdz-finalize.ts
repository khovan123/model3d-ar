import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import {
  strFromU8,
  unzipSync
} from "three/addons/libs/fflate.module.js";

type USDZExporterPrototype = USDZExporter & {
  __modelSpaceQuickLookFinalizePatch?: boolean;
};

type MaterialSnapshot = {
  material: THREE.MeshStandardMaterial;
  emissive: THREE.Color;
  emissiveMap: THREE.Texture | null;
  emissiveIntensity: number;
};

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

      // Keep the original PBR diffuse map and mirror it into emissive only on
      // the temporary USDZ export scene. This helps Quick Look preserve painted
      // artwork on materials that otherwise render too dark or washed out.
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

function auditNativeBehavior(usda: string) {
  const typedTap = usda.includes("inherits = </TapGestureTrigger>");
  const typedGroup = usda.includes("inherits = </GroupAction>");
  const typedVisibility = usda.includes("inherits = </VisibilityAction>");
  const sceneStart = usda.includes("inherits = </SceneTransitionTrigger>");
  const show = usda.includes('token info:id = "show"');
  const hide = usda.includes('token info:id = "hide"');
  const hardHidden = /token\s+visibility\s*=\s*"invisible"/.test(usda);

  console.info(
    `[ModelSpace] Quick Look behavior audit: tap=${typedTap}, group=${typedGroup}, visibility=${typedVisibility}, sceneStart=${sceneStart}, show=${show}, hide=${hide}, hardHidden=${hardHidden}.`
  );

  if (!typedTap || !typedGroup || !typedVisibility || !sceneStart || !show || !hide || hardHidden) {
    console.warn("[ModelSpace] Quick Look native behavior graph is incomplete or contains hard USD visibility.");
  }
}

function auditUsdArchive(buffer: Uint8Array<ArrayBuffer>) {
  try {
    const files = unzipSync(buffer);
    const modelFile = files["model.usda"];
    if (!modelFile) return;

    const usda = strFromU8(modelFile);
    auditTextureAssets(usda, files);
    auditNativeBehavior(usda);
  } catch (error) {
    console.warn("[ModelSpace] Unable to audit Quick Look USDZ.", error);
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
      // Do not set UsdGeomImageable visibility="invisible" on the plaque.
      // Apple's VisibilityAction uses its own runtime state and explicitly does
      // not modify the USD visible property. Initial hiding is authored as a
      // SceneTransitionTrigger -> VisibilityAction instead.
      auditUsdArchive(output);
      return output;
    } finally {
      restoreMaterials();
    }
  };
}
