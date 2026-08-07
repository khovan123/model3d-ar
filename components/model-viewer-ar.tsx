"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as WebGLTextureUtils from "three/addons/utils/WebGLTextureUtils.js";
import { ModelViewer as BaseModelViewer } from "./model-viewer-fixed";
import styles from "./model-viewer.module.css";

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
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
let activeModelScene: THREE.Object3D | null = null;
let activeModelAnchorLocal = new THREE.Vector3(0, 1.08, 0);
let activeRenderer: THREE.WebGLRenderer | null = null;
let activeRenderCamera: THREE.Camera | null = null;

function clipPriority(clip: THREE.AnimationClip, index: number) {
  const name = clip.name.trim().toLowerCase();
  let score = 0;

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

function isHierarchyVisible(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function getInteractionCamera() {
  if (!activeRenderer || !activeRenderCamera) return null;
  if (!activeRenderer.xr.isPresenting) return activeRenderCamera;

  const xrCamera = activeRenderer.xr.getCamera(activeRenderCamera as THREE.PerspectiveCamera);
  if (xrCamera instanceof THREE.ArrayCamera && xrCamera.cameras.length > 0) {
    return xrCamera.cameras[0];
  }
  return xrCamera;
}

function installRenderTracking() {
  const prototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & {
    __modelSpaceRenderTrackingPatch?: boolean;
  };
  if (prototype.__modelSpaceRenderTrackingPatch) return;
  prototype.__modelSpaceRenderTrackingPatch = true;

  const originalRender = THREE.WebGLRenderer.prototype.render;
  THREE.WebGLRenderer.prototype.render = function (scene: THREE.Object3D, camera: THREE.Camera) {
    activeRenderer = this;
    activeRenderCamera = camera;
    return originalRender.call(this, scene, camera);
  };
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
      stopActiveMixers();
      activeModelScene = gltf.scene;

      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      activeModelAnchorLocal = new THREE.Vector3(
        center.x,
        bounds.max.y + Math.max(0.04, size.y * 0.08),
        center.z
      );

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

installRenderTracking();
installGLTFAnimationPlayback();
installUSDZTextureCompatibility();

export function ModelViewer({ modelName, description, assetUrl, audioUrl }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLButtonElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);

  const toggleAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audioAvailable) return;

    if (!audio.paused) {
      audio.pause();
      setAudioPlaying(false);
      return;
    }

    try {
      await audio.play();
      setAudioPlaying(true);
    } catch (error) {
      console.warn("Unable to play model audio", error);
      setAudioPlaying(false);
    }
  }, [audioAvailable]);

  const inspectModelAt = useCallback((clientX: number, clientY: number) => {
    if (!activeModelScene || !activeRenderer || !isHierarchyVisible(activeModelScene)) return;
    const camera = getInteractionCamera();
    if (!camera) return;

    const rect = activeRenderer.domElement.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(activeModelScene, true);
    if (hits.length > 0) setInfoOpen(true);
  }, []);

  const onPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, textarea")) {
      pointerStartRef.current = null;
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }, []);

  const onPointerUpCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    inspectModelAt(event.clientX, event.clientY);
  }, [inspectModelAt]);

  useEffect(() => {
    let raf = 0;
    const worldAnchor = new THREE.Vector3();
    const projected = new THREE.Vector3();

    const updateLabel = () => {
      const label = labelRef.current;
      const model = activeModelScene;
      const renderer = activeRenderer;
      const camera = getInteractionCamera();

      if (!label || !model || !renderer || !camera || !isHierarchyVisible(model)) {
        if (label) label.style.opacity = "0";
        raf = requestAnimationFrame(updateLabel);
        return;
      }

      worldAnchor.copy(activeModelAnchorLocal);
      model.localToWorld(worldAnchor);
      projected.copy(worldAnchor).project(camera);

      if (projected.z < -1 || projected.z > 1 || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
        label.style.opacity = "0";
        raf = requestAnimationFrame(updateLabel);
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
      label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      label.style.opacity = "1";
      raf = requestAnimationFrame(updateLabel);
    };

    raf = requestAnimationFrame(updateLabel);
    return () => {
      cancelAnimationFrame(raf);
      activeModelScene = null;
      activeRenderer = null;
      activeRenderCamera = null;
      stopActiveMixers();
    };
  }, [assetUrl]);

  return (
    <div
      ref={hostRef}
      className={styles.viewerHost}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
    >
      <BaseModelViewer modelName={modelName} description={description} assetUrl={assetUrl} />

      <button
        ref={labelRef}
        type="button"
        className={styles.modelNameLabel}
        onClick={() => setInfoOpen(true)}
        aria-label={`Xem thông tin ${modelName}`}
      >
        <span>{modelName}</span>
        <small>Chạm để xem</small>
      </button>

      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          playsInline
          onCanPlay={() => setAudioAvailable(true)}
          onError={() => { setAudioAvailable(false); setAudioPlaying(false); }}
          onEnded={() => setAudioPlaying(false)}
        />
      )}

      {infoOpen && (
        <>
          <button
            type="button"
            className={styles.infoBackdrop}
            aria-label="Đóng thông tin model"
            onClick={() => setInfoOpen(false)}
          />
          <section className={styles.modelInfoCard} aria-label={`Thông tin ${modelName}`}>
            <button
              type="button"
              className={styles.infoClose}
              onClick={() => setInfoOpen(false)}
              aria-label="Đóng"
            >
              ×
            </button>
            <small>MODEL</small>
            <h2>{modelName}</h2>
            <p>{description || "Model này chưa có mô tả."}</p>
            {audioAvailable && (
              <button type="button" className={styles.audioButton} onClick={() => void toggleAudio()}>
                <span aria-hidden="true">{audioPlaying ? "❚❚" : "▶"}</span>
                {audioPlaying ? "Tạm dừng âm thanh" : "Phát âm thanh"}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}