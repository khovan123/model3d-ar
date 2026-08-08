"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";

// Keep the existing animation, USDZ and texture compatibility patches active.
import "./model-viewer-ar";
import { ModelViewer as BaseModelViewer } from "./model-viewer-fixed";
import baseStyles from "./model-viewer.module.css";
import overlayStyles from "./model-info-overlay.module.css";

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
};

type ModelSpaceInfo = {
  name: string;
  description: string;
};

type XRSessionOptionsLike = {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
  domOverlay?: { root: Element };
  [key: string]: unknown;
};

type XRRequestSessionLike = (
  mode: string,
  options?: XRSessionOptionsLike
) => Promise<unknown>;

type XRPrototypeLike = {
  requestSession?: XRRequestSessionLike;
  __modelSpaceDomOverlayPatch?: boolean;
};

type AnchorPrototypeLike = HTMLAnchorElement & {
  __modelSpaceQuickLookInfoPatch?: boolean;
};

type USDZExporterPrototypeLike = USDZExporter & {
  __modelSpaceEmbeddedPlaquePatch?: boolean;
};

const modelNamesByAssetUrl = new Map<string, string>();
const modelDescriptionsByAssetUrl = new Map<string, string>();
const NAMEPLATE_OBJECT_NAME = "__modelspace_nameplate__";
const QUICK_LOOK_PLAQUE_NAME = "__modelspace_quicklook_plaque__";
const AR_OVERLAY_ROOT_ID = "modelspace-ar-overlay-root";
const QUICK_LOOK_INFO_EVENT = "modelspace:quicklook-info";

let currentQuickLookInfo: ModelSpaceInfo | null = null;

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function createNameplateTexture(modelName: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  roundedRectPath(context, 20, 24, 984, 208, 54);
  context.fillStyle = "rgba(10, 10, 10, 0.82)";
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = "rgba(255, 255, 255, 0.28)";
  context.stroke();

  let fontSize = 92;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.font = `800 ${fontSize}px Arial, sans-serif`;
  while (fontSize > 42 && context.measureText(modelName).width > 880) {
    fontSize -= 4;
    context.font = `800 ${fontSize}px Arial, sans-serif`;
  }
  context.fillText(modelName, canvas.width / 2, canvas.height / 2 + 3);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function disposeNameplate(object: THREE.Object3D) {
  if (!(object instanceof THREE.Mesh)) return;
  object.geometry.dispose();
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.forEach((material) => {
    if (material instanceof THREE.MeshBasicMaterial) material.map?.dispose();
    material.dispose();
  });
}

function add3DNameplate(gltf: { scene: THREE.Group }, modelName: string, bounds: THREE.Box3) {
  const existing = gltf.scene.getObjectByName(NAMEPLATE_OBJECT_NAME);
  if (existing) {
    existing.removeFromParent();
    disposeNameplate(existing);
  }

  const texture = createNameplateTexture(modelName);
  if (!texture) return;

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) || 1;

  const geometry = new THREE.PlaneGeometry(largest * 0.64, largest * 0.16);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  });

  const nameplate = new THREE.Mesh(geometry, material);
  nameplate.name = NAMEPLATE_OBJECT_NAME;
  nameplate.position.set(center.x, bounds.max.y + largest * 0.12, center.z);
  nameplate.renderOrder = 20;
  nameplate.castShadow = false;
  nameplate.receiveShadow = false;
  nameplate.userData.modelSpaceOverlay = true;

  // The plate is a real Three.js object attached to the GLB root. It therefore
  // follows the model when the user rotates, scales, places or repositions it.
  gltf.scene.add(nameplate);
  gltf.scene.updateMatrixWorld(true);
}

function install3DNameplatePatch() {
  const loaderPrototype = GLTFLoader.prototype as GLTFLoader & {
    __modelSpace3DNameplatePatch?: boolean;
  };
  if (loaderPrototype.__modelSpace3DNameplatePatch) return;
  loaderPrototype.__modelSpace3DNameplatePatch = true;

  const originalLoad = GLTFLoader.prototype.load;
  type LoadArguments = Parameters<GLTFLoader["load"]>;
  type LoadCallback = LoadArguments[1];

  GLTFLoader.prototype.load = function (
    url: LoadArguments[0],
    onLoad: LoadCallback,
    onProgress?: LoadArguments[2],
    onError?: LoadArguments[3]
  ) {
    const assetUrl = String(url);
    const wrappedOnLoad: LoadCallback = (gltf) => {
      const modelName = modelNamesByAssetUrl.get(assetUrl);
      const description = modelDescriptionsByAssetUrl.get(assetUrl) ?? "";

      // Store metadata on the GLB itself before the base viewer clones the
      // normalized root for USDZ. Object3D.clone() preserves userData, so the
      // exporter patch can always recover the right model information.
      if (modelName) {
        gltf.scene.userData.modelSpaceInfo = { name: modelName, description } satisfies ModelSpaceInfo;
      }

      // Capture bounds before the base viewer normalizes the GLB. Adding the
      // live Three.js plate after onLoad returns keeps it out of normalization.
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      onLoad(gltf);

      if (modelName) add3DNameplate(gltf, modelName, bounds);
    };

    return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
  };
}

function fitCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  weight = 800
) {
  let fontSize = startSize;
  context.font = `${weight} ${fontSize}px Arial, sans-serif`;
  while (fontSize > minSize && context.measureText(text).width > maxWidth) {
    fontSize -= 2;
    context.font = `${weight} ${fontSize}px Arial, sans-serif`;
  }
  return fontSize;
}

function drawDescriptionLines(
  context: CanvasRenderingContext2D,
  description: string,
  x: number,
  y: number,
  maxWidth: number
) {
  const clean = description.replace(/\s+/g, " ").trim();
  if (!clean) return;

  context.font = "500 34px Arial, sans-serif";
  context.fillStyle = "rgba(255,255,255,0.74)";
  context.textAlign = "left";
  context.textBaseline = "top";

  const words = clean.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === 2) break;
  }
  if (line && lines.length < 2) lines.push(line);

  const consumed = lines.join(" ");
  if (clean.length > consumed.length && lines.length > 0) {
    let last = lines.length - 1;
    let shortened = `${lines[last]}…`;
    while (shortened.length > 2 && context.measureText(shortened).width > maxWidth) {
      shortened = `${shortened.slice(0, -2)}…`;
    }
    lines[last] = shortened;
  }

  lines.forEach((text, index) => context.fillText(text, x, y + index * 44));
}

function createQuickLookPlaqueTexture(info: ModelSpaceInfo) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) return null;

  // Use a fully opaque card because it survives USDZ / Quick Look conversion
  // more consistently than DOM-like translucent UI.
  roundedRectPath(context, 8, 8, 1008, 344, 52);
  context.fillStyle = "#111111";
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = "rgba(255,255,255,0.3)";
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = "rgba(255,255,255,0.52)";
  context.font = "800 25px Arial, sans-serif";
  context.fillText("MODEL 3D", 54, 44);

  const name = info.name.trim() || "Model 3D";
  const nameFontSize = fitCanvasText(context, name, 720, 66, 38);
  context.font = `800 ${nameFontSize}px Arial, sans-serif`;
  context.fillStyle = "#ffffff";
  context.fillText(name, 54, 86);

  drawDescriptionLines(context, info.description, 54, 180, 760);

  context.beginPath();
  context.arc(906, 180, 65, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.fillStyle = "#111111";
  context.font = "900 88px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("!", 906, 186);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function findModelSpaceInfo(scene: THREE.Object3D) {
  let info: ModelSpaceInfo | null = null;
  scene.traverse((object) => {
    if (info) return;
    const candidate = object.userData.modelSpaceInfo as Partial<ModelSpaceInfo> | undefined;
    if (!candidate || typeof candidate.name !== "string" || !candidate.name.trim()) return;
    info = {
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : ""
    };
  });
  return info;
}

function createQuickLookPlaque(scene: THREE.Object3D, info: ModelSpaceInfo) {
  const texture = createQuickLookPlaqueTexture(info);
  if (!texture) return null;

  // Do not let the older live-view nameplate affect sizing or duplicate itself
  // in Quick Look. It shares resources with the live scene, so hide only.
  const oldNameplate = scene.getObjectByName(NAMEPLATE_OBJECT_NAME);
  const oldNameplateVisibility = oldNameplate?.visible;
  if (oldNameplate) oldNameplate.visible = false;

  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) || 1;

  const geometry = new THREE.PlaneGeometry(largest * 0.82, largest * 0.288);
  const makeMaterial = () => {
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: THREE.FrontSide
    });
    material.emissive.set(0xffffff);
    material.emissiveMap = texture;
    material.emissiveIntensity = 0.18;
    material.toneMapped = false;
    return material;
  };

  const frontMaterial = makeMaterial();
  const backMaterial = makeMaterial();
  const front = new THREE.Mesh(geometry, frontMaterial);
  const back = new THREE.Mesh(geometry, backMaterial);
  front.position.z = largest * 0.003;
  back.position.z = -largest * 0.003;
  back.rotation.y = Math.PI;

  const plaque = new THREE.Group();
  plaque.name = QUICK_LOOK_PLAQUE_NAME;
  plaque.position.set(center.x, bounds.max.y + largest * 0.19, center.z);
  plaque.add(front, back);
  plaque.userData.modelSpaceOverlay = true;
  scene.add(plaque);
  scene.updateMatrixWorld(true);

  return {
    plaque,
    geometry,
    texture,
    materials: [frontMaterial, backMaterial],
    restoreOldNameplate: () => {
      if (oldNameplate && oldNameplateVisibility !== undefined) {
        oldNameplate.visible = oldNameplateVisibility;
      }
    }
  };
}

function installEmbeddedQuickLookPlaquePatch() {
  const prototype = USDZExporter.prototype as USDZExporterPrototypeLike;
  if (prototype.__modelSpaceEmbeddedPlaquePatch) return;
  prototype.__modelSpaceEmbeddedPlaquePatch = true;

  const originalParseAsync = USDZExporter.prototype.parseAsync;

  USDZExporter.prototype.parseAsync = async function (
    scene: THREE.Object3D,
    options?: Parameters<USDZExporter["parseAsync"]>[1]
  ) {
    const info = findModelSpaceInfo(scene);
    if (!info || scene.getObjectByName(QUICK_LOOK_PLAQUE_NAME)) {
      return originalParseAsync.call(this, scene, options);
    }

    const embedded = createQuickLookPlaque(scene, info);
    if (!embedded) return originalParseAsync.call(this, scene, options);

    try {
      return await originalParseAsync.call(this, scene, options);
    } finally {
      embedded.plaque.removeFromParent();
      embedded.restoreOldNameplate();
      embedded.geometry.dispose();
      embedded.materials.forEach((material) => material.dispose());
      embedded.texture.dispose();
      scene.updateMatrixWorld(true);
    }
  };
}

function installWebXrDomOverlayPatch() {
  if (typeof navigator === "undefined") return;
  const xr = (navigator as Navigator & { xr?: object }).xr;
  if (!xr) return;

  const prototype = Object.getPrototypeOf(xr) as XRPrototypeLike;
  const originalRequestSession = prototype.requestSession;
  if (!originalRequestSession || prototype.__modelSpaceDomOverlayPatch) return;
  prototype.__modelSpaceDomOverlayPatch = true;

  prototype.requestSession = function (mode: string, options?: XRSessionOptionsLike) {
    if (mode !== "immersive-ar") {
      return originalRequestSession.call(this, mode, options);
    }

    const overlayRoot = document.getElementById(AR_OVERLAY_ROOT_ID);
    if (!overlayRoot) {
      return originalRequestSession.call(this, mode, options);
    }

    const optionalFeatures = Array.from(new Set([
      ...(options?.optionalFeatures ?? []),
      "dom-overlay"
    ]));

    return originalRequestSession.call(this, mode, {
      ...options,
      optionalFeatures,
      domOverlay: { root: overlayRoot }
    });
  };
}

function installQuickLookInfoPatch() {
  if (typeof window === "undefined" || typeof HTMLAnchorElement === "undefined") return;

  const prototype = HTMLAnchorElement.prototype as AnchorPrototypeLike;
  if (prototype.__modelSpaceQuickLookInfoPatch) return;
  prototype.__modelSpaceQuickLookInfoPatch = true;

  const originalClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function () {
    const relTokens = this.rel.toLowerCase().split(/\s+/).filter(Boolean);
    const info = currentQuickLookInfo;

    if (!relTokens.includes("ar") || !info || this.dataset.modelSpaceQuickLook === "1") {
      return originalClick.call(this);
    }

    // AR Quick Look is a native iOS surface, so webpage DOM cannot stay on top
    // of it. Use Apple's supported custom-action banner when available. The
    // embedded USDZ plaque remains the reliable fallback and is always visible.
    const quickLookAnchor = this.cloneNode(true) as HTMLAnchorElement;
    quickLookAnchor.dataset.modelSpaceQuickLook = "1";
    quickLookAnchor.style.position = "fixed";
    quickLookAnchor.style.width = "1px";
    quickLookAnchor.style.height = "1px";
    quickLookAnchor.style.opacity = "0";
    quickLookAnchor.style.pointerEvents = "none";

    const subtitle = (info.description.trim() || `Thông tin model 3D ${info.name}`)
      .replace(/\s+/g, " ")
      .slice(0, 160);
    const params = new URLSearchParams({
      callToAction: "! Thông tin",
      checkoutTitle: info.name,
      checkoutSubtitle: subtitle
    });
    const baseHref = this.href.split("#")[0];
    quickLookAnchor.href = `${baseHref}#${params.toString()}`;

    let cleanupTimer = 0;
    const cleanup = () => {
      if (cleanupTimer) window.clearTimeout(cleanupTimer);
      quickLookAnchor.removeEventListener("message", onMessage as EventListener);
      quickLookAnchor.remove();
    };
    const onMessage = (event: Event) => {
      const message = event as MessageEvent;
      if (message.data !== "_apple_ar_quicklook_button_tapped") return;
      window.dispatchEvent(new CustomEvent(QUICK_LOOK_INFO_EVENT));
      cleanup();
    };

    quickLookAnchor.addEventListener("message", onMessage as EventListener);
    document.body.appendChild(quickLookAnchor);
    cleanupTimer = window.setTimeout(cleanup, 10 * 60 * 1000);
    return originalClick.call(quickLookAnchor);
  };
}

install3DNameplatePatch();
installEmbeddedQuickLookPlaquePatch();

export function ModelViewer({ modelName, description, assetUrl, audioUrl }: Props) {
  // Register synchronously so GLTFLoader can resolve display metadata even if
  // the child viewer starts loading immediately after mount.
  modelNamesByAssetUrl.set(assetUrl, modelName);
  modelDescriptionsByAssetUrl.set(assetUrl, description);

  const audioRef = useRef<HTMLAudioElement>(null);
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

  useEffect(() => {
    currentQuickLookInfo = { name: modelName, description };
    installWebXrDomOverlayPatch();
    installQuickLookInfoPatch();

    const audioElement = audioRef.current;
    const openQuickLookInfo = () => setInfoOpen(true);
    window.addEventListener(QUICK_LOOK_INFO_EVENT, openQuickLookInfo);

    return () => {
      window.removeEventListener(QUICK_LOOK_INFO_EVENT, openQuickLookInfo);
      audioElement?.pause();
      if (modelNamesByAssetUrl.get(assetUrl) === modelName) {
        modelNamesByAssetUrl.delete(assetUrl);
      }
      if (modelDescriptionsByAssetUrl.get(assetUrl) === description) {
        modelDescriptionsByAssetUrl.delete(assetUrl);
      }
      if (currentQuickLookInfo?.name === modelName) {
        currentQuickLookInfo = null;
      }
    };
  }, [assetUrl, description, modelName]);

  return (
    <div id={AR_OVERLAY_ROOT_ID} className={baseStyles.viewerHost}>
      <BaseModelViewer modelName={modelName} description={description} assetUrl={assetUrl} />

      <button
        type="button"
        className={overlayStyles.infoTrigger}
        onClick={() => setInfoOpen(true)}
        aria-label={`Xem thông tin ${modelName}`}
        aria-haspopup="dialog"
        aria-expanded={infoOpen}
        title="Thông tin model"
      >
        <span aria-hidden="true">!</span>
      </button>

      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          playsInline
          onCanPlay={() => setAudioAvailable(true)}
          onError={() => {
            setAudioAvailable(false);
            setAudioPlaying(false);
          }}
          onEnded={() => setAudioPlaying(false)}
        />
      )}

      {infoOpen && (
        <>
          <button
            type="button"
            className={overlayStyles.infoBackdrop}
            aria-label="Đóng thông tin model"
            onClick={() => setInfoOpen(false)}
          />
          <section
            className={overlayStyles.modelInfoCard}
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-info-title"
          >
            <button
              type="button"
              className={overlayStyles.infoClose}
              onClick={() => setInfoOpen(false)}
              aria-label="Đóng"
            >
              ×
            </button>
            <small>THÔNG TIN MODEL 3D</small>
            <h2 id="model-info-title">{modelName}</h2>
            <p>{description || "Model này chưa có mô tả."}</p>
            {audioAvailable && (
              <button type="button" className={overlayStyles.audioButton} onClick={() => void toggleAudio()}>
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
