import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync
} from "three/addons/libs/fflate.module.js";

const PLAQUE_NAME = "__modelspace_quicklook_plaque__";
const AUDIO_BUTTON_NAME = "__modelspace_quicklook_audio_button__";
const BEHAVIOR_NAME = "ModelSpaceTapInfo";
const HIDE_BEHAVIOR_NAME = "ModelSpaceHideInfo";
const REPLAY_AUDIO_BEHAVIOR_NAME = "ModelSpaceReplayAudio";

let quickLookAudioSourceUrl: string | null = null;

type UsdPrim = {
  indent: number;
  type: string;
  name: string;
  path: string;
};

type AudioAsset = {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
};

type USDZExporterPrototype = USDZExporter & {
  __modelSpaceNativeBehaviorPatch?: boolean;
};

export function setQuickLookAudioSource(url?: string) {
  quickLookAudioSourceUrl = url?.trim() || null;
}

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

function audioExtension(contentType: string | null) {
  const mime = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") return "m4a";
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return "wav";
  if (mime === "audio/aac" || mime === "audio/x-aac") return "aac";
  if (mime === "audio/ogg") return "ogg";
  return "m4a";
}

async function fetchQuickLookAudio(): Promise<AudioAsset | null> {
  const source = quickLookAudioSourceUrl;
  if (!source) return null;

  try {
    const separator = source.includes("?") ? "&" : "?";
    const response = await fetch(`${source}${separator}embed=1`, {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;

    const extension = audioExtension(response.headers.get("content-type"));
    return {
      fileName: `audio/modelspace-audio.${extension}`,
      bytes
    };
  } catch (error) {
    console.warn("[ModelSpace] Unable to embed model audio into Quick Look USDZ.", error);
    return null;
  }
}

function injectAudioButton(usda: string) {
  if (usda.includes(`"${AUDIO_BUTTON_NAME}"`)) return usda;

  const lines = usda.split("\n");
  const plaqueIndex = lines.findIndex((line) =>
    new RegExp(`^(\\t*)def\\s+\\w+\\s+"${AUDIO_BUTTON_NAME.replace("audio_button", "quicklook_plaque")}"`).test(line)
  );

  // Prefer an exact lookup because the generated plaque name is stable.
  const exactPlaqueIndex = lines.findIndex((line) =>
    line.includes(`def Xform "${PLAQUE_NAME}"`) || line.includes(`def "${PLAQUE_NAME}"`)
  );
  const startIndex = exactPlaqueIndex >= 0 ? exactPlaqueIndex : plaqueIndex;
  if (startIndex < 0) return usda;

  const indentMatch = lines[startIndex].match(/^(\t*)/);
  const plaqueIndent = indentMatch?.[1] ?? "";
  let plaqueCloseIndex = -1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index] === `${plaqueIndent}}`) {
      plaqueCloseIndex = index;
      break;
    }
  }
  if (plaqueCloseIndex < 0) return usda;

  const i1 = `${plaqueIndent}\t`;
  const i2 = `${i1}\t`;
  const i3 = `${i2}\t`;
  const button = `${i1}def Xform "${AUDIO_BUTTON_NAME}"
${i1}{
${i2}double3 xformOp:translate = (0.29, 0, 0.014)
${i2}uniform token[] xformOpOrder = ["xformOp:translate"]

${i2}def Mesh "AudioDisk"
${i2}{
${i3}uniform bool doubleSided = 1
${i3}point3f[] points = [(-0.060, 0, 0), (-0.0424, 0.0424, 0), (0, 0.060, 0), (0.0424, 0.0424, 0), (0.060, 0, 0), (0.0424, -0.0424, 0), (0, -0.060, 0), (-0.0424, -0.0424, 0)]
${i3}int[] faceVertexCounts = [8]
${i3}int[] faceVertexIndices = [0, 1, 2, 3, 4, 5, 6, 7]
${i3}color3f[] primvars:displayColor = [(1, 1, 1)] ( interpolation = "constant" )
${i3}float[] primvars:displayOpacity = [1] ( interpolation = "constant" )
${i3}uniform token subdivisionScheme = "none"
${i2}}

${i2}def Mesh "PlayGlyph"
${i2}{
${i3}uniform bool doubleSided = 1
${i3}point3f[] points = [(-0.018, -0.027, 0.002), (-0.018, 0.027, 0.002), (0.030, 0, 0.002)]
${i3}int[] faceVertexCounts = [3]
${i3}int[] faceVertexIndices = [0, 1, 2]
${i3}color3f[] primvars:displayColor = [(0.06, 0.06, 0.06)] ( interpolation = "constant" )
${i3}float[] primvars:displayOpacity = [1] ( interpolation = "constant" )
${i3}uniform token subdivisionScheme = "none"
${i2}}
${i1}}`;

  lines.splice(plaqueCloseIndex, 0, "", ...button.split("\n"), "");
  return lines.join("\n");
}

function audioActionBlock(name: string, audioFileName: string, modelRootPath: string, indent: string) {
  const child = `${indent}\t`;
  return `${indent}def Preliminary_Action "${name}"
${indent}{
${child}uniform token info:id = "Audio"
${child}uniform token type = "play"
${child}uniform asset audio = @${audioFileName}@
${child}uniform double gain = 1
${child}rel affectedObjects = [ <${modelRootPath}> ]
${indent}}`;
}

function buildBehaviorBlock(prims: UsdPrim[], audioFileName?: string) {
  const scenePath = "/Root/Scenes/Scene";
  const modelRoot = prims.find(
    (prim) =>
      prim.indent === 3 &&
      prim.path.startsWith(`${scenePath}/`) &&
      prim.name !== PLAQUE_NAME &&
      !prim.name.startsWith("ModelSpace")
  );
  const plaque = prims.find((prim) => prim.name === PLAQUE_NAME);
  const audioButton = prims.find((prim) => prim.name === AUDIO_BUTTON_NAME);

  if (!modelRoot || !plaque) return null;

  const modelTapTargets = prims
    .filter(
      (prim) =>
        prim.type === "Mesh" &&
        prim.path.startsWith(`${modelRoot.path}/`) &&
        !prim.path.includes(`/${PLAQUE_NAME}/`)
    )
    .map((prim) => prim.path);

  const audioButtonPrefix = audioButton ? `${audioButton.path}/` : "";
  const plaqueTapTargets = prims
    .filter(
      (prim) =>
        prim.type === "Mesh" &&
        prim.path.startsWith(`${plaque.path}/`) &&
        (!audioButtonPrefix || !prim.path.startsWith(audioButtonPrefix))
    )
    .map((prim) => prim.path);

  const audioTapTargets = audioButton
    ? prims
        .filter((prim) => prim.type === "Mesh" && prim.path.startsWith(`${audioButton.path}/`))
        .map((prim) => prim.path)
    : [];

  if (modelTapTargets.length === 0) modelTapTargets.push(modelRoot.path);
  if (plaqueTapTargets.length === 0) plaqueTapTargets.push(plaque.path);

  const i3 = "\t\t\t";
  const i4 = `${i3}\t`;
  const i5 = `${i4}\t`;
  const modelActions = audioFileName
    ? "[ <Feedback>, <ShowInfo>, <PlayAudio> ]"
    : "[ <Feedback>, <ShowInfo> ]";
  const modelAudioAction = audioFileName
    ? `\n${audioActionBlock("PlayAudio", audioFileName, modelRoot.path, i4)}\n`
    : "";

  const replayBehavior = audioFileName && audioButton && audioTapTargets.length > 0
    ? `
${i3}def Preliminary_Behavior "${REPLAY_AUDIO_BEHAVIOR_NAME}"
${i3}{
${i4}rel triggers = [ <TapAudio> ]
${i4}rel actions = [ <ReplayAudio>, <AudioFeedback> ]

${i4}def Preliminary_Trigger "TapAudio"
${i4}{
${i5}uniform token info:id = "tap"
${i5}rel affectedObjects = ${usdTargets(audioTapTargets, `${i5}\t`)}
${i4}}

${audioActionBlock("ReplayAudio", audioFileName, modelRoot.path, i4)}

${i4}def Preliminary_Action "AudioFeedback"
${i4}{
${i5}uniform token info:id = "emphasize"
${i5}uniform token motionType = "pulse"
${i5}rel affectedObjects = [ <${audioButton.path}> ]
${i4}}
${i3}}
`
    : "";

  const block = `${i3}def Preliminary_Behavior "${BEHAVIOR_NAME}"
${i3}{
${i4}rel triggers = [ <TapModel> ]
${i4}rel actions = ${modelActions}

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
${modelAudioAction}${i3}}

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
${replayBehavior}`;

  return {
    block,
    modelTapTargetCount: modelTapTargets.length,
    plaquePath: plaque.path,
    hasAudio: Boolean(audioFileName),
    audioTapTargetCount: audioTapTargets.length
  };
}

function injectIntoScene(usda: string, audioFileName?: string) {
  if (usda.includes(`Preliminary_Behavior "${BEHAVIOR_NAME}"`)) return usda;

  const workingUsda = audioFileName ? injectAudioButton(usda) : usda;
  const lines = workingUsda.split("\n");
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

  const behavior = buildBehaviorBlock(parseUsdPrims(workingUsda), audioFileName);
  if (!behavior) return usda;

  lines.splice(sceneCloseIndex, 0, "", ...behavior.block.trimEnd().split("\n"), "");
  console.info(
    `[ModelSpace] Quick Look native behavior authored for ${behavior.modelTapTargetCount} model mesh target(s); plaque ${behavior.plaquePath}; audio=${behavior.hasAudio ? `yes (${behavior.audioTapTargetCount} replay target(s))` : "no"}.`
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

    offset = file.length;
  }

  return zipSync(aligned, { level: 0 });
}

async function authorNativeBehavior(buffer: Uint8Array<ArrayBuffer>) {
  try {
    const files = unzipSync(buffer);
    const modelFile = files["model.usda"];
    if (!modelFile) return buffer;

    const original = strFromU8(modelFile);
    if (!original.includes(PLAQUE_NAME)) return buffer;

    const audioAsset = await fetchQuickLookAudio();
    const next = injectIntoScene(original, audioAsset?.fileName);
    if (next === original) return buffer;

    files["model.usda"] = strToU8(next);
    if (audioAsset) files[audioAsset.fileName] = audioAsset.bytes;
    return alignAndZip(files);
  } catch (error) {
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
