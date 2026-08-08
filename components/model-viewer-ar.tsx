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

type AnimationPatchState = {
  mixer: THREE.AnimationMixer;
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
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

let activeAnimationState: AnimationPatchState | null = null;
let activeAnimationClips: THREE.AnimationClip[] = [];

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
 * GLB exporters do not always store one logical animation as one clip. Blender,
 * Maya and conversion pipelines can emit one clip per animated object/bone.
 * Playing only a "main" clip therefore makes otherwise animated models appear
 * static. We keep the preferred clip, then add every clip whose target channels
 * do not conflict with channels already selected. Distinct part clips run in
 * parallel; alternate actions that animate the same property are not blended
 * on top of each other.
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
    const conflicts = keys.some((key) => occupiedChannels.has(key));
    if (conflicts) continue;

    selected.push(clip);
    keys.forEach((key) => occupiedChannels.add(key));
  }

  // Preserve file order for deterministic playback/export while keeping only
  // the compatible set selected above.
  const selectedSet = new Set(selected);
  return clips.filter((clip) => selectedSet.has(clip));
}

function stopActiveAnimation() {
  const state = activeAnimationState;
  if (state) {
    state.mixer.stopAllAction();
    state.mixer.uncacheRoot(state.root);
  }
  activeAnimationState = null;
  activeAnimationClips = [];
}

function startAnimationSet(root: THREE.Object3D, sourceClips: THREE.AnimationClip[]) {
  stopActiveAnimation();

  const clips = choosePlaybackClips(sourceClips);
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

  activeAnimationState = { mixer, root, clips };
  activeAnimationClips = clips;

  const duration = Math.max(...clips.map((clip) => clip.duration));
  root.userData.modelSpaceAnimation = {
    animated: true,
    clips: clips.map((clip) => clip.name),
    clipCount: sourceClips.length,
    playingClipCount: clips.length,
    duration
  };

  console.info(
    `[ModelSpace] Playing ${clips.length}/${sourceClips.length} compatible animation clip(s): ${clips
      .map((clip) => `"${clip.name || "Unnamed"}"`)
      .join(", ")}.`
  );
}

function installGLTFAnimationPlayback() {
  const loaderPrototype = GLTFLoader.prototype as GLTFLoader & {
    __modelSpaceAnimationSetPatch?: boolean;
  };
  if (loaderPrototype.__modelSpaceAnimationSetPatch) return;
  loaderPrototype.__modelSpaceAnimationSetPatch = true;

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
      startAnimationSet(gltf.scene, gltf.animations);
      onLoad(gltf);
    };

    return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
  };

  const rendererPrototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & {
    __modelSpaceAnimationSetLoopPatch?: boolean;
  };
  if (rendererPrototype.__modelSpaceAnimationSetLoopPatch) return;
  rendererPrototype.__modelSpaceAnimationSetLoopPatch = true;

  const originalSetAnimationLoop = THREE.WebGLRenderer.prototype.setAnimationLoop;
  const rendererTimes = new WeakMap<THREE.WebGLRenderer, number>();
  type AnimationLoop = Parameters<THREE.WebGLRenderer["setAnimationLoop"]>[0];

  THREE.WebGLRenderer.prototype.setAnimationLoop = function (callback: AnimationLoop) {
    if (!callback) {
      rendererTimes.delete(this);
      return originalSetAnimationLoop.call(this, null);
    }

    rendererTimes.set(this, performance.now());
    const wrapped: NonNullable<AnimationLoop> = (time, frame) => {
      const previous = rendererTimes.get(this) ?? time;
      const delta = THREE.MathUtils.clamp((time - previous) / 1000, 0, 0.1);
      rendererTimes.set(this, time);

      const state = activeAnimationState;
      if (state) state.mixer.update(delta);
      callback(time, frame);
    };

    return originalSetAnimationLoop.call(this, wrapped);
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

function installUSDZTextureAndAnimationCompatibility() {
  const prototype = USDZExporter.prototype as USDZExporter & {
    __modelSpaceTextureAnimationSetPatch?: boolean;
  };
  if (prototype.__modelSpaceTextureAnimationSetPatch) return;
  prototype.__modelSpaceTextureAnimationSetPatch = true;

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

    const exportOptions = activeAnimationClips.length > 0
      ? {
          ...options,
          animations: activeAnimationClips,
          animationFrameRate: 60
        }
      : options;

    if (activeAnimationClips.length > 0) {
      console.info(
        `[ModelSpace] Exporting ${activeAnimationClips.length} animation clip(s) to Quick Look USDZ.`
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
installUSDZTextureAndAnimationCompatibility();
