"use client";

import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as WebGLTextureUtils from "three/addons/utils/WebGLTextureUtils.js";
import { ModelViewer as BaseModelViewer } from "./model-viewer-fixed";

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
};

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

const activeMixers = new Set<THREE.AnimationMixer>();
let activeAnimationClip: THREE.AnimationClip | null = null;

function clipPriority(clip: THREE.AnimationClip, index: number) {
  const name = clip.name.trim().toLowerCase();
  let score = 0;

  // Prefer a model-level/default clip over small per-part clips. This makes
  // assets such as "Anim Blye" play their intended main animation without
  // hard-coding an asset-specific clip name.
  if (/^(anim|animation)(\b|[_.-])/.test(name)) score = 100;
  else if (/(^|[\s_.-])(main|default|idle|loop)([\s_.-]|$)/.test(name)) score = 90;
  else if (/(^|[\s_.-])(take|action)([\s_.-]|$)/.test(name)) score = 75;

  if (clip.duration > 0) score += 10;
  return score - index * 0.001;
}

function chooseDefaultClip(clips: THREE.AnimationClip[]) {
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

function stopActiveMixers() {
  activeMixers.forEach((mixer) => {
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot());
  });
  activeMixers.clear();
  activeAnimationClip = null;
}

function installGLTFAnimationPlayback() {
  const loaderPrototype = GLTFLoader.prototype as GLTFLoader & {
    __modelSpaceAnimationPatch?: boolean;
  };
  if (loaderPrototype.__modelSpaceAnimationPatch) return;
  loaderPrototype.__modelSpaceAnimationPatch = true;

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
      // This viewer shows one GLB at a time. Stop a previous asset's mixer if
      // the route/model changes before registering the new one.
      stopActiveMixers();

      const clip = chooseDefaultClip(gltf.animations);
      if (clip) {
        activeAnimationClip = clip;
        const mixer = new THREE.AnimationMixer(gltf.scene);
        const action = mixer.clipAction(clip);
        action.reset();
        action.enabled = true;
        action.setEffectiveWeight(1);
        action.setEffectiveTimeScale(1);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        activeMixers.add(mixer);

        gltf.scene.userData.modelSpaceAnimation = {
          animated: true,
          clip: clip.name,
          clipCount: gltf.animations.length,
          duration: clip.duration
        };
        console.info(
          `[ModelSpace] Playing animation "${clip.name}" (${clip.duration.toFixed(2)}s) from ${gltf.animations.length} clip(s).`
        );
      } else {
        gltf.scene.userData.modelSpaceAnimation = {
          animated: false,
          clipCount: 0
        };
        console.info("[ModelSpace] Static GLB: no embedded animation clips.");
      }

      onLoad(gltf);
    };

    return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
  };

  const rendererPrototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & {
    __modelSpaceAnimationLoopPatch?: boolean;
  };
  if (rendererPrototype.__modelSpaceAnimationLoopPatch) return;
  rendererPrototype.__modelSpaceAnimationLoopPatch = true;

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
      // Clamp after tab/background switches so a model does not jump several
      // seconds forward in a single frame.
      const delta = THREE.MathUtils.clamp((time - previous) / 1000, 0, 0.1);
      rendererTimes.set(this, time);
      activeMixers.forEach((mixer) => mixer.update(delta));
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
    console.warn("Unable to bake texture to canvas for USDZ", error);
    return null;
  }
}

function bakeTexture(texture: THREE.Texture, ownedTextures: Set<THREE.Texture>) {
  // Compressed GPU textures are handled by USDZExporter through
  // WebGLTextureUtils. Keeping the original object here lets the exporter
  // invoke its official decompression path.
  if (texture instanceof THREE.CompressedTexture) return texture;

  const canvas = canvasFromDrawableTexture(texture);
  if (!canvas) return texture;

  const baked = new THREE.CanvasTexture(canvas);
  copyTextureSettings(texture, baked);
  ownedTextures.add(baked);
  return baked;
}

function installUSDZTextureCompatibility() {
  const prototype = USDZExporter.prototype as USDZExporter & { __modelSpaceTexturePatch?: boolean };
  if (prototype.__modelSpaceTexturePatch) return;
  prototype.__modelSpaceTexturePatch = true;

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

    const exportOptions = activeAnimationClip
      ? {
          ...options,
          animations: [activeAnimationClip],
          animationFrameRate: 60
        }
      : options;

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
installUSDZTextureCompatibility();

export function ModelViewer(props: Props) {
  return <BaseModelViewer {...props} />;
}
