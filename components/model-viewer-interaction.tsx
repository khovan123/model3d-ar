"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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

const modelNamesByAssetUrl = new Map<string, string>();
const NAMEPLATE_OBJECT_NAME = "__modelspace_nameplate__";

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
      // Capture bounds before the base viewer normalizes the GLB. Adding the
      // plate after onLoad returns keeps it out of the normalization bounds.
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      onLoad(gltf);

      const modelName = modelNamesByAssetUrl.get(assetUrl);
      if (modelName) add3DNameplate(gltf, modelName, bounds);
    };

    return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
  };
}

install3DNameplatePatch();

export function ModelViewer({ modelName, description, assetUrl, audioUrl }: Props) {
  // Register synchronously so GLTFLoader can resolve the display name even if
  // the model finishes loading before React effects run.
  modelNamesByAssetUrl.set(assetUrl, modelName);

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
    return () => {
      const audio = audioRef.current;
      audio?.pause();
      if (modelNamesByAssetUrl.get(assetUrl) === modelName) {
        modelNamesByAssetUrl.delete(assetUrl);
      }
    };
  }, [assetUrl, modelName]);

  return (
    <div className={baseStyles.viewerHost}>
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
