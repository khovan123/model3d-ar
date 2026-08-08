"use client";

import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as WebGLTextureUtils from "three/addons/utils/WebGLTextureUtils.js";

type TextureSlot =
  | "map"
  | "emissiveMap"
  | "normalMap"
  | "aoMap"
  | "roughnessMap"
  | "metalnessMap"
  | "alphaMap"
  | "clearcoatMap"
  | "clearcoatRoughnessMap";

type AnimationState = {
  mixer: THREE.AnimationMixer;
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
  sourceId: string;
};

const TEXTURE_SLOTS: TextureSlot[] = [
  "map",
  "emissiveMap",
  "normalMap",
  "aoMap",
  "roughnessMap",
  "metalnessMap",
  "alphaMap",
  "clearcoatMap",
  "clearcoatRoughnessMap"
];

const MAX_TRACKED_ANIMATION_STATES = 8;
const ANIMATION_SOURCE_KEY = "modelSpaceAnimationSourceId";
const animationStates: AnimationState[] = [];
const animationClipsBySourceId = new Map<string, THREE.AnimationClip[]>();
let animationSourceSequence = 0;

function animationTrackKey(track: THREE.KeyframeTrack) {
  try {
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    return [
      binding.nodeName ?? "",
      binding.objectName ?? "",
      String(binding.objectIndex ?? ""),
      binding.propertyName ?? "",
      String(binding.propertyIndex ?? "")
    ].join("|");
  } catch {
    return track.name;
  }
}

function clipPriority(clip: THREE.AnimationClip, index: number) {
  const name = clip.name.trim().toLowerCase();
  let score = 0;

  if (/^(anim|animation)(\b|[_.-])/.test(name)) score = 100;
  else if (/(^|[\s_.-])(main|default|idle|loop)([\s_.-]|$)/.test(name)) score = 90;
  else if (/(^|[\s_.-])(take|action)([\s_.-]|$)/.test(name)) score = 75;

  if (clip.duration > 0) score += 10;
  score += Math.min(clip.tracks.length, 50) * 0.05;
  return score - index * 0.001;
}

function choosePrimaryClip(clips: THREE.AnimationClip[]) {
  if (clips.length === 0) return null;

  let best = clips[0];
  let bestScore = clipPriority(best, 0);
  for (let index = 1; index < clips.length; index += 1) {
    const score = clipPriority(clips[index], index);
    if (score > bestScore) {
      best = clips[index];
      bestScore = score;
    }
  }
  return best;
}

/**
 * Some GLB exporters split one logical animation across many clips. Keep a
 * preferred clip and add every non-conflicting clip so separate bones/parts
 * still animate together without blending alternate actions over each other.
 */
function choosePlaybackClips(sourceClips: THREE.AnimationClip[]) {
  const clips = sourceClips.filter((clip) => {
    if (clip.tracks.length === 0) return false;
    if (!(clip.duration > 0)) clip.resetDuration();
    return Number.isFinite(clip.duration) && clip.duration > 0;
  });

  if (clips.length <= 1) return clips;

  const primary = choosePrimaryClip(clips) ?? clips[0];
  const selected: THREE.AnimationClip[] = [primary];
  const occupiedChannels = new Set(primary.tracks.map(animationTrackKey));

  for (const clip of clips) {
    if (clip === primary) continue;
    const keys = clip.tracks.map(animationTrackKey);
    if (keys.some((key) => occupiedChannels.has(key))) continue;

    selected.push(clip);
    keys.forEach((key) => occupiedChannels.add(key));
  }

  const selectedSet = new Set(selected);
  return clips.filter((clip) => selectedSet.has(clip));
}

function disposeAnimationState(state: AnimationState) {
  state.mixer.stopAllAction();
  state.mixer.uncacheRoot(state.root);
  if (animationClipsBySourceId.get(state.sourceId) === state.clips) {
    animationClipsBySourceId.delete(state.sourceId);
  }
}

function pruneAnimationStates() {
  while (animationStates.length > MAX_TRACKED_ANIMATION_STATES) {
    const stale = animationStates.shift();
    if (stale) disposeAnimationState(stale);
  }
}

function startAnimationSet(root: THREE.Object3D, sourceClips: THREE.AnimationClip[]) {
  const clips = choosePlaybackClips(sourceClips);
  const sourceId = `modelspace-animation-${++animationSourceSequence}`;
  root.userData[ANIMATION_SOURCE_KEY] = sourceId;
  animationClipsBySourceId.set(sourceId, clips);

  if (clips.length === 0) {
    root.userData.modelSpaceAnimation = {
      animated: false,
      clipCount: sourceClips.length,
      playingClipCount: 0
    };
    console.info("[ModelSpace] Static GLB: no playable embedded animation clips.");
    return;
  }

  const mixer = new THREE.AnimationMixer(root);
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
  }
  mixer.setTime(0);

  const state: AnimationState = { mixer, root, clips, sourceId };
  animationStates.push(state);
  pruneAnimationStates();

  const duration = Math.max(...clips.map((clip) => clip.duration));
  root.userData.modelSpaceAnimation = {
    animated: true,
    clips: clips.map((clip) => clip.name),
    clipCount: sourceClips.length,
    playingClipCount: clips.length,
    duration,
    sourceId
  };

  console.info(
    `[ModelSpace] Playing ${clips.length}/${sourceClips.length} compatible animation clip(s): ${clips
      .map((clip) => `"${clip.name || "Unnamed"}"`)
      .join(", ")}.`
  );
}

function installGLTFAnimationPlayback() {
  const loaderPrototype = GLTFLoader.prototype as GLTFLoader & {
    __modelSpaceAnimationMultiLoadPatch?: boolean;
  };
  if (loaderPrototype.__modelSpaceAnimationMultiLoadPatch) return;
  loaderPrototype.__modelSpaceAnimationMultiLoadPatch = true;

  const originalLoad = GLTFLoader.prototype.load;
  type LoadArguments = Parameters<GLTFLoader["load"]>;
  type LoadCallback = LoadArguments[1];

  GLTFLoader.prototype.load = function (
    url: LoadArguments[0],
    onLoad: LoadCallback,
    onProgress?: LoadArguments[2],
    onError?: LoadArguments[3]
  ) {
    const wrappedOnLoad: LoadCallback = (gltf) => {
      // Never stop another load here. React development/streaming navigation can
      // leave an older GLTF request in flight; if it resolves late it must not
      // freeze the scene that is currently rendered.
      startAnimationSet(gltf.scene, gltf.animations);
      onLoad(gltf);
    };

    return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
  };
}

/**
 * Update mixers immediately before the real Three.js render. This is more
 * reliable than wrapping setAnimationLoop because the same render path is used
 * by normal Object mode and WebXR, and it remains valid if WebXR replaces its
 * internal animation callback while a session starts.
 */
function installAnimationRenderUpdate() {
  const rendererPrototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & {
    __modelSpaceAnimationRenderPatch?: boolean;
  };
  if (rendererPrototype.__modelSpaceAnimationRenderPatch) return;
  rendererPrototype.__modelSpaceAnimationRenderPatch = true;

  const originalRender = THREE.WebGLRenderer.prototype.render;
  const rendererTimes = new WeakMap<THREE.WebGLRenderer, number>();

  THREE.WebGLRenderer.prototype.render = function (scene: THREE.Object3D, camera: THREE.Camera) {
    const now = performance.now();
    const previous = rendererTimes.get(this) ?? now;
    const delta = THREE.MathUtils.clamp((now - previous) / 1000, 0, 0.1);
    rendererTimes.set(this, now);

    if (delta > 0) {
      for (const state of animationStates) {
        state.mixer.update(delta);
      }
    }

    return originalRender.call(this, scene, camera);
  };
}

function copyTextureSettings(source: THREE.Texture, target: THREE.Texture) {
  target.name = source.name;
  target.mapping = source.mapping;
  target.channel = source.channel;
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.magFilter = source.magFilter;
  target.minFilter = source.minFilter;
  target.anisotropy = source.anisotropy;
  target.offset.copy(source.offset);
  target.repeat.copy(source.repeat);
  target.center.copy(source.center);
  target.rotation = source.rotation;
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  target.matrix.copy(source.matrix);
  target.flipY = source.flipY;
  target.premultiplyAlpha = source.premultiplyAlpha;
  target.unpackAlignment = source.unpackAlignment;
  target.colorSpace = source.colorSpace;
  target.userData = { ...source.userData, mimeType: "image/png" };
  target.needsUpdate = true;
}

function canvasFromDataTexture(image: unknown) {
  if (!image || typeof image !== "object") return null;
  const candidate = image as { data?: ArrayBufferView; width?: number; height?: number };
  const { data, width, height } = candidate;
  if (!data || !width || !height) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;

  const pixelCount = width * height;
  let rgba: Uint8ClampedArray<ArrayBuffer>;

  if (data.length === pixelCount * 4) {
    rgba = new Uint8ClampedArray(pixelCount * 4);
    rgba.set(data);
  } else if (data.length === pixelCount * 3) {
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let src = 0, dst = 0; src < data.length; src += 3, dst += 4) {
      rgba[dst] = data[src];
      rgba[dst + 1] = data[src + 1];
      rgba[dst + 2] = data[src + 2];
      rgba[dst + 3] = 255;
    }
  } else {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

function canvasFromDrawableTexture(texture: THREE.Texture, maxTextureSize = 2048) {
  const dataCanvas = canvasFromDataTexture(texture.image);
  if (dataCanvas) return dataCanvas;

  const image = texture.image as { width?: number; height?: number } | null | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!width || !height) return null;

  const scale = Math.min(1, maxTextureSize / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return null;

  try {
    context.drawImage(texture.image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    console.warn("[ModelSpace] Unable to bake texture to canvas for USDZ.", error);
    return null;
  }
}

function bakeTexture(texture: THREE.Texture, ownedTextures: Set<THREE.Texture>) {
  if (texture instanceof THREE.CompressedTexture) return texture;

  const canvas = canvasFromDrawableTexture(texture);
  if (!canvas) return texture;

  const baked = new THREE.CanvasTexture(canvas);
  copyTextureSettings(texture, baked);
  ownedTextures.add(baked);
  return baked;
}

function findSceneAnimationClips(scene: THREE.Object3D) {
  let clips: THREE.AnimationClip[] | null = null;
  scene.traverse((object) => {
    if (clips) return;
    const sourceId = object.userData[ANIMATION_SOURCE_KEY];
    if (typeof sourceId !== "string") return;
    const candidate = animationClipsBySourceId.get(sourceId);
    if (candidate && candidate.length > 0) clips = candidate;
  });
  return clips ?? [];
}

function installUSDZTextureAndAnimationCompatibility() {
  const prototype = USDZExporter.prototype as USDZExporter & {
    __modelSpaceTextureAnimationSourcePatch?: boolean;
  };
  if (prototype.__modelSpaceTextureAnimationSourcePatch) return;
  prototype.__modelSpaceTextureAnimationSourcePatch = true;

  const originalParseAsync = USDZExporter.prototype.parseAsync;

  USDZExporter.prototype.parseAsync = async function (
    scene: THREE.Object3D,
    options?: Parameters<USDZExporter["parseAsync"]>[1]
  ) {
    this.setTextureUtils(WebGLTextureUtils);

    const ownedTextures = new Set<THREE.Texture>();
    const replacements: Array<{
      material: Record<string, unknown>;
      slot: TextureSlot;
      original: THREE.Texture;
    }> = [];
    const cache = new Map<THREE.Texture, THREE.Texture>();

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];

      materials.forEach((material) => {
        const record = material as unknown as Record<string, unknown>;
        TEXTURE_SLOTS.forEach((slot) => {
          const current = record[slot];
          if (!(current instanceof THREE.Texture)) return;

          let baked = cache.get(current);
          if (!baked) {
            baked = bakeTexture(current, ownedTextures);
            cache.set(current, baked);
          }

          if (baked === current) return;
          replacements.push({ material: record, slot, original: current });
          record[slot] = baked;
        });
      });
    });

    // Prefer animations explicitly supplied by the caller. Otherwise recover
    // the clips that belong to this exact cloned GLB scene via its source ID.
    // This prevents an older overlapping load from donating the wrong clips.
    const explicitAnimations = options?.animations ?? [];
    const sceneAnimations = explicitAnimations.length > 0
      ? explicitAnimations
      : findSceneAnimationClips(scene);
    const exportOptions = sceneAnimations.length > 0
      ? {
          ...options,
          animations: sceneAnimations,
          animationFrameRate: 60
        }
      : options;

    if (sceneAnimations.length > 0) {
      console.info(
        `[ModelSpace] Exporting ${sceneAnimations.length} scene-owned animation clip(s) to Quick Look USDZ.`
      );
    }

    try {
      return await originalParseAsync.call(this, scene, exportOptions);
    } finally {
      replacements.forEach(({ material, slot, original }) => {
        material[slot] = original;
      });
      ownedTextures.forEach((texture) => texture.dispose());
    }
  };
}

installGLTFAnimationPlayback();
installAnimationRenderUpdate();
installUSDZTextureAndAnimationCompatibility();
