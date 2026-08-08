import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync
} from "three/addons/libs/fflate.module.js";

const PLAQUE_NAME = "__modelspace_quicklook_plaque__";
const BEHAVIOR_NAME = "ModelSpaceTapInfo";
const HIDE_BEHAVIOR_NAME = "ModelSpaceHideInfo";

type UsdPrim = {
  indent: number;
  type: string;
  name: string;
  path: string;
};

type USDZExporterPrototype = USDZExporter & {
  __modelSpaceNativeBehaviorPatch?: boolean;
};

function parseUsdPrims(usda: string) {
  const stack: string[] = [];
  const prims: UsdPrim[] = [];

  for (const line of usda.split("\n")) {
    const match = line.match(/^(\t*)def\s+(?:(\w+)\s+)?"([^"]+)"/);
    if (!match) continue;

    const indent = match[1].length;
    const type = match[2] ?? "";
    const name = match[3];
    stack.length = indent;
    stack[indent] = name;

    prims.push({
      indent,
      type,
      name,
      path: `/${stack.slice(0, indent + 1).join("/")}`
    });
  }

  return prims;
}

function usdTargets(paths: string[], indent: string) {
  if (paths.length === 1) return `[ <${paths[0]}> ]`;
  return `[\n${paths.map((path) => `${indent}<${path}>`).join(",\n")}\n${indent.slice(0, -1)}]`;
}

function buildBehaviorBlock(prims: UsdPrim[]) {
  const scenePath = "/Root/Scenes/Scene";
  const modelRoot = prims.find(
    (prim) => prim.indent === 3 && prim.path.startsWith(`${scenePath}/`) && prim.name !== PLAQUE_NAME
  );
  const plaque = prims.find((prim) => prim.name === PLAQUE_NAME);

  if (!modelRoot || !plaque) return null;

  const modelTapTargets = prims
    .filter(
      (prim) =>
        prim.type === "Mesh" &&
        prim.path.startsWith(`${modelRoot.path}/`) &&
        !prim.path.includes(`/${PLAQUE_NAME}/`)
    )
    .map((prim) => prim.path);

  const plaqueTapTargets = prims
    .filter(
      (prim) => prim.type === "Mesh" && prim.path.startsWith(`${plaque.path}/`)
    )
    .map((prim) => prim.path);

  if (modelTapTargets.length === 0) modelTapTargets.push(modelRoot.path);
  if (plaqueTapTargets.length === 0) plaqueTapTargets.push(plaque.path);

  const i3 = "\t\t\t";
  const i4 = `${i3}\t`;
  const i5 = `${i4}\t`;

  const block = `${i3}def Preliminary_Behavior "${BEHAVIOR_NAME}"
${i3}{
${i4}rel triggers = [ <TapModel> ]
${i4}rel actions = [ <Feedback>, <ShowInfo> ]

${i4}def Preliminary_Trigger "TapModel"
${i4}{
${i5}uniform token info:id = "tap"
${i5}rel affectedObjects = ${usdTargets(modelTapTargets, `${i5}\t`)}
${i4}}

${i4}def Preliminary_Action "Feedback"
${i4}{
${i5}uniform token info:id = "emphasize"
${i5}uniform token motionType = "bounce"
${i5}rel affectedObjects = [ <${modelRoot.path}> ]
${i4}}

${i4}def Preliminary_Action "ShowInfo"
${i4}{
${i5}uniform token info:id = "visibility"
${i5}uniform token type = "show"
${i5}uniform double duration = 0.18
${i5}rel affectedObjects = [ <${plaque.path}> ]
${i4}}
${i3}}

${i3}def Preliminary_Behavior "${HIDE_BEHAVIOR_NAME}"
${i3}{
${i4}rel triggers = [ <TapInfo> ]
${i4}rel actions = [ <HideInfo> ]

${i4}def Preliminary_Trigger "TapInfo"
${i4}{
${i5}uniform token info:id = "tap"
${i5}rel affectedObjects = ${usdTargets(plaqueTapTargets, `${i5}\t`)}
${i4}}

${i4}def Preliminary_Action "HideInfo"
${i4}{
${i5}uniform token info:id = "visibility"
${i5}uniform token type = "hide"
${i5}uniform double duration = 0.18
${i5}rel affectedObjects = [ <${plaque.path}> ]
${i4}}
${i3}}
`;

  return {
    block,
    modelTapTargetCount: modelTapTargets.length,
    plaquePath: plaque.path
  };
}

function injectIntoScene(usda: string) {
  if (usda.includes(`Preliminary_Behavior "${BEHAVIOR_NAME}"`)) return usda;

  const lines = usda.split("\n");
  const sceneDefinitionIndex = lines.findIndex((line) => /^\t\tdef Xform "Scene"/.test(line));
  if (sceneDefinitionIndex < 0) return usda;

  let sceneCloseIndex = -1;
  for (let index = sceneDefinitionIndex + 1; index < lines.length; index += 1) {
    if (lines[index] === "\t\t}") {
      sceneCloseIndex = index;
      break;
    }
  }
  if (sceneCloseIndex < 0) return usda;

  const behavior = buildBehaviorBlock(parseUsdPrims(usda));
  if (!behavior) return usda;

  lines.splice(sceneCloseIndex, 0, "", ...behavior.block.trimEnd().split("\n"), "");
  console.info(
    `[ModelSpace] Quick Look native tap behavior authored for ${behavior.modelTapTargetCount} model mesh target(s); plaque ${behavior.plaquePath}.`
  );
  return lines.join("\n");
}

function alignAndZip(files: Record<string, Uint8Array>) {
  const orderedEntries = Object.entries(files).sort(([a], [b]) => {
    if (a === "model.usda") return -1;
    if (b === "model.usda") return 1;
    return 0;
  });

  const aligned: Record<string, Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }]> = {};
  let offset = 0;

  for (const [filename, file] of orderedEntries) {
    const headerSize = 34 + filename.length;
    offset += headerSize;
    const offsetMod64 = offset & 63;

    if (offsetMod64 !== 4) {
      const padLength = 64 - offsetMod64;
      aligned[filename] = [file, { extra: { 12345: new Uint8Array(padLength) } }];
    } else {
      aligned[filename] = file;
    }

    // Match Three.js USDZExporter alignment logic. The beginning of each file's
    // payload is aligned to byte 4 modulo 64 as required by USDZ readers.
    offset = file.length;
  }

  const zipped = zipSync(aligned, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

function authorNativeBehavior(buffer: ArrayBuffer) {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const modelFile = files["model.usda"];
    if (!modelFile) return buffer;

    const original = strFromU8(modelFile);
    if (!original.includes(PLAQUE_NAME)) return buffer;

    const next = injectIntoScene(original);
    if (next === original) return buffer;

    files["model.usda"] = strToU8(next);
    return alignAndZip(files);
  } catch (error) {
    // Never make AR unusable because behavior authoring failed. Quick Look can
    // still open the original Three.js USDZ without the interactive extension.
    console.warn("[ModelSpace] Unable to author Quick Look native behavior; using original USDZ.", error);
    return buffer;
  }
}

export function installQuickLookTapBehaviorPatch() {
  const prototype = USDZExporter.prototype as USDZExporterPrototype;
  if (prototype.__modelSpaceNativeBehaviorPatch) return;
  prototype.__modelSpaceNativeBehaviorPatch = true;

  const originalParseAsync = USDZExporter.prototype.parseAsync;
  USDZExporter.prototype.parseAsync = async function (
    scene,
    options
  ) {
    const output = await originalParseAsync.call(this, scene, options);
    return authorNativeBehavior(output);
  };
}
