"use client";

import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
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
    rgba = new Uint8ClampedArray(data.length);
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

    try {
      return await originalParseAsync.call(this, scene, options);
    } finally {
      replacements.forEach(({ material, slot, original }) => {
        material[slot] = original;
      });
      ownedTextures.forEach((texture) => texture.dispose());
    }
  };
}

installUSDZTextureCompatibility();

export function ModelViewer(props: Props) {
  return <BaseModelViewer {...props} />;
}
