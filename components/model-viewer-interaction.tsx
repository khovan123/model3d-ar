"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Keep the existing animation, USDZ and texture compatibility patches active.
import "./model-viewer-ar";
import { ModelViewer as BaseModelViewer } from "./model-viewer-fixed";
import styles from "./model-viewer.module.css";

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
};

type PointerStart = {
  x: number;
  y: number;
  pointerId: number;
};

let interactionModel: THREE.Object3D | null = null;
let interactionAnchorLocal = new THREE.Vector3(0, 1.08, 0);
let interactionRenderer: THREE.WebGLRenderer | null = null;
let interactionRenderCamera: THREE.Camera | null = null;

function isHierarchyVisible(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function getInteractionCamera() {
  if (!interactionRenderer || !interactionRenderCamera) return null;
  if (!interactionRenderer.xr.isPresenting) return interactionRenderCamera;

  const xrCamera = interactionRenderer.xr.getCamera();
  if (xrCamera instanceof THREE.ArrayCamera && xrCamera.cameras.length > 0) {
    return xrCamera.cameras[0];
  }
  return xrCamera;
}

function rememberRenderer(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
  interactionRenderer = renderer;
  interactionRenderCamera = camera;
}

function installInteractionTracking() {
  const loaderPrototype = GLTFLoader.prototype as GLTFLoader & {
    __modelSpacePreciseInteractionPatch?: boolean;
  };

  if (!loaderPrototype.__modelSpacePreciseInteractionPatch) {
    loaderPrototype.__modelSpacePreciseInteractionPatch = true;
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
        interactionModel = gltf.scene;

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        interactionAnchorLocal = new THREE.Vector3(
          center.x,
          bounds.max.y + Math.max(0.04, size.y * 0.08),
          center.z
        );

        onLoad(gltf);
      };

      return originalLoad.call(this, url, wrappedOnLoad, onProgress, onError);
    };
  }

  const rendererPrototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & {
    __modelSpacePreciseRenderTrackingPatch?: boolean;
  };

  if (!rendererPrototype.__modelSpacePreciseRenderTrackingPatch) {
    rendererPrototype.__modelSpacePreciseRenderTrackingPatch = true;
    const originalRender = THREE.WebGLRenderer.prototype.render;

    THREE.WebGLRenderer.prototype.render = function (scene: THREE.Object3D, camera: THREE.Camera) {
      rememberRenderer(this, camera);
      return originalRender.call(this, scene, camera);
    };
  }
}

installInteractionTracking();

export function ModelViewer({ modelName, description, assetUrl, audioUrl }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pointerStartRef = useRef<PointerStart | null>(null);
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
    const model = interactionModel;
    const renderer = interactionRenderer;
    const camera = getInteractionCamera();
    if (!model || !renderer || !camera || !isHierarchyVisible(model)) return;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(model, true);
    if (hits.length > 0) setInfoOpen(true);
  }, []);

  useEffect(() => {
    let animationFrame = 0;
    let attachedCanvas: HTMLCanvasElement | null = null;

    const onPointerDown = (event: PointerEvent) => {
      pointerStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId
      };
    };

    const clearPointer = () => {
      pointerStartRef.current = null;
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;
      if (!start || start.pointerId !== event.pointerId) return;

      // A drag belongs to OrbitControls / AR manipulation, not the info action.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
      inspectModelAt(event.clientX, event.clientY);
    };

    const attachToCanvas = () => {
      const canvas = interactionRenderer?.domElement ?? null;
      const host = hostRef.current;

      if (!canvas || !host?.contains(canvas)) {
        animationFrame = requestAnimationFrame(attachToCanvas);
        return;
      }

      attachedCanvas = canvas;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", clearPointer);
    };

    animationFrame = requestAnimationFrame(attachToCanvas);

    return () => {
      cancelAnimationFrame(animationFrame);
      if (attachedCanvas) {
        attachedCanvas.removeEventListener("pointerdown", onPointerDown);
        attachedCanvas.removeEventListener("pointerup", onPointerUp);
        attachedCanvas.removeEventListener("pointercancel", clearPointer);
      }
      pointerStartRef.current = null;
    };
  }, [assetUrl, inspectModelAt]);

  useEffect(() => {
    let animationFrame = 0;
    const worldAnchor = new THREE.Vector3();
    const projected = new THREE.Vector3();

    const updateLabel = () => {
      const label = labelRef.current;
      const model = interactionModel;
      const renderer = interactionRenderer;
      const camera = getInteractionCamera();

      if (!label || !model || !renderer || !camera || !isHierarchyVisible(model)) {
        if (label) label.style.opacity = "0";
        animationFrame = requestAnimationFrame(updateLabel);
        return;
      }

      worldAnchor.copy(interactionAnchorLocal);
      model.localToWorld(worldAnchor);
      projected.copy(worldAnchor).project(camera);

      if (
        projected.z < -1 ||
        projected.z > 1 ||
        !Number.isFinite(projected.x) ||
        !Number.isFinite(projected.y)
      ) {
        label.style.opacity = "0";
        animationFrame = requestAnimationFrame(updateLabel);
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
      label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      label.style.opacity = "1";
      animationFrame = requestAnimationFrame(updateLabel);
    };

    animationFrame = requestAnimationFrame(updateLabel);
    return () => cancelAnimationFrame(animationFrame);
  }, [assetUrl]);

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      audio?.pause();
      interactionModel = null;
      interactionRenderer = null;
      interactionRenderCamera = null;
    };
  }, []);

  return (
    <div ref={hostRef} className={styles.viewerHost}>
      <BaseModelViewer modelName={modelName} description={description} assetUrl={assetUrl} />

      <div
        ref={labelRef}
        className={styles.modelNameLabel}
        style={{ pointerEvents: "none" }}
        aria-hidden="true"
      >
        <span>{modelName}</span>
        <small>Chạm trực tiếp vào model để xem</small>
      </div>

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
