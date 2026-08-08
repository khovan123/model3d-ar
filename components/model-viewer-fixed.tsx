"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  disposeModelAnimationsForScene,
  updateActiveModelAnimations
} from "./model-viewer-ar";
import styles from "./model-viewer.module.css";

type ViewerMode = "ar" | "object";
type ArEngine = "checking" | "webxr" | "quicklook-preparing" | "quicklook" | "unsupported";
type ArGestureMode = "idle" | "pending" | "rotate" | "move" | "scale";
type ThreeXRSession = NonNullable<Parameters<THREE.WebXRManager["setSession"]>[0]>;

type XRSystemLike = {
  isSessionSupported: (mode: "immersive-ar") => Promise<boolean>;
  requestSession: (
    mode: "immersive-ar",
    options?: {
      requiredFeatures?: string[];
      optionalFeatures?: string[];
      domOverlay?: { root: Element };
    }
  ) => Promise<ThreeXRSession>;
};

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  usdzUrl?: string;
};

type MaterialLike = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  normalScale?: THREE.Vector2;
  roughness?: number;
  roughnessMap?: THREE.Texture | null;
  metalness?: number;
  metalnessMap?: THREE.Texture | null;
  aoMap?: THREE.Texture | null;
  aoMapIntensity?: number;
  emissive?: THREE.Color;
  emissiveMap?: THREE.Texture | null;
  emissiveIntensity?: number;
  alphaMap?: THREE.Texture | null;
  alphaTest?: number;
  opacity?: number;
  transparent?: boolean;
  side?: THREE.Side;
  vertexColors?: boolean;
};

const WEBXR_FRAME_COVERAGE = 0.38;
const WEBXR_FALLBACK_SCALE = 0.28;
const WEBXR_MIN_INITIAL_SCALE = 0.1;
const WEBXR_MAX_INITIAL_SCALE = 0.42;
const QUICK_LOOK_TARGET_MAX_SIZE_METERS = 0.32;

function isAppleMobile() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function distanceBetweenTouches(touches: TouchList) {
  if (touches.length < 2) return 0;
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );
}

function getPrimaryXrCamera(camera: THREE.Camera) {
  if (camera instanceof THREE.ArrayCamera && camera.cameras.length > 0) {
    return camera.cameras[0];
  }
  return camera;
}

function fitScaleToXrFrame(camera: THREE.Camera, distance: number, normalizedSize: THREE.Vector3) {
  const projection = camera.projectionMatrix.elements;
  const projectionX = Math.abs(projection[0]);
  const projectionY = Math.abs(projection[5]);
  if (!Number.isFinite(projectionX) || !Number.isFinite(projectionY) || projectionX <= 0 || projectionY <= 0) {
    return WEBXR_FALLBACK_SCALE;
  }

  const safeDistance = Math.max(0.25, distance);
  const visibleWidth = (2 * safeDistance) / projectionX;
  const visibleHeight = (2 * safeDistance) / projectionY;
  const modelWidth = Math.max(normalizedSize.x, 0.05);
  const modelHeight = Math.max(normalizedSize.y, 0.05);
  const fitted = Math.min(
    (visibleWidth * WEBXR_FRAME_COVERAGE) / modelWidth,
    (visibleHeight * WEBXR_FRAME_COVERAGE) / modelHeight
  );

  return THREE.MathUtils.clamp(fitted, WEBXR_MIN_INITIAL_SCALE, WEBXR_MAX_INITIAL_SCALE);
}

function normalizeTexture(texture: THREE.Texture | null | undefined, colorTexture = false) {
  if (!texture) return null;
  if (colorTexture) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createUSDZMaterial(source: THREE.Material) {
  const material = source as MaterialLike;
  const isStandard = source instanceof THREE.MeshStandardMaterial;
  const standard = isStandard
    ? (source.clone() as THREE.MeshStandardMaterial)
    : new THREE.MeshStandardMaterial();

  standard.name = source.name;
  standard.color.copy(material.color ?? new THREE.Color(0xffffff));
  standard.map = normalizeTexture(material.map, true);
  standard.normalMap = normalizeTexture(material.normalMap);
  if (material.normalScale) standard.normalScale.copy(material.normalScale);
  standard.roughness = material.roughness ?? (isStandard ? standard.roughness : 0.82);
  standard.roughnessMap = normalizeTexture(material.roughnessMap);
  standard.metalness = material.metalness ?? (isStandard ? standard.metalness : 0);
  standard.metalnessMap = normalizeTexture(material.metalnessMap);
  standard.aoMap = normalizeTexture(material.aoMap);
  standard.aoMapIntensity = material.aoMapIntensity ?? 1;
  standard.emissive.copy(material.emissive ?? new THREE.Color(0x000000));
  standard.emissiveMap = normalizeTexture(material.emissiveMap, true);
  standard.emissiveIntensity = material.emissiveIntensity ?? 1;
  standard.alphaMap = normalizeTexture(material.alphaMap);
  standard.alphaTest = material.alphaTest ?? 0;
  standard.opacity = material.opacity ?? 1;
  standard.transparent = material.transparent ?? standard.opacity < 1;
  standard.side = material.side ?? THREE.FrontSide;
  standard.vertexColors = material.vertexColors ?? false;

  // KHR_materials_unlit is loaded as MeshBasicMaterial. USDZExporter is
  // designed around MeshStandardMaterial, so preserve the diffuse texture
  // and add a small emissive contribution to keep unlit artwork recognizable.
  if (source instanceof THREE.MeshBasicMaterial) {
    standard.roughness = 1;
    standard.metalness = 0;
    if (standard.map) {
      standard.emissive.set(0xffffff);
      standard.emissiveMap = standard.map;
      standard.emissiveIntensity = 0.22;
    }
  }

  standard.needsUpdate = true;
  return standard;
}

function buildUSDZExportRoot(sourceRoot: THREE.Group) {
  const modelClone = sourceRoot.clone(true);
  const exportRoot = new THREE.Group();
  const ownedMaterials: THREE.Material[] = [];

  modelClone.visible = true;
  modelClone.position.set(0, 0, 0);
  modelClone.rotation.set(0, 0, 0);
  modelClone.scale.setScalar(QUICK_LOOK_TARGET_MAX_SIZE_METERS);
  exportRoot.name = "__modelspace_quicklook_root__";
  exportRoot.add(modelClone);

  exportRoot.traverse((object) => {
    object.visible = true;
    if (!(object instanceof THREE.Mesh)) return;

    if (Array.isArray(object.material)) {
      object.material = object.material.map((material) => {
        const converted = createUSDZMaterial(material);
        ownedMaterials.push(converted);
        return converted;
      });
    } else {
      const converted = createUSDZMaterial(object.material);
      ownedMaterials.push(converted);
      object.material = converted;
    }
  });

  exportRoot.updateMatrixWorld(true);
  return { exportRoot, ownedMaterials };
}

function revokeBlobUrl(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

export function ModelViewer({ modelName, description, assetUrl, usdzUrl }: Props) {
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const floorRef = useRef<THREE.Mesh | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const sessionRef = useRef<ThreeXRSession | null>(null);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const quickLookUrlRef = useRef<string | null>(null);
  const modeRef = useRef<ViewerMode>("ar");
  const arEngineRef = useRef<ArEngine>("checking");
  const modelReadyRef = useRef(false);
  const placedRef = useRef(false);
  const trackingReadyRef = useRef(false);
  const repositioningRef = useRef(false);
  const placementScaleRef = useRef(WEBXR_FALLBACK_SCALE);
  const normalizedModelSizeRef = useRef(new THREE.Vector3(1, 1, 1));

  const [mode, setMode] = useState<ViewerMode>("ar");
  const [arEngine, setArEngine] = useState<ArEngine>("checking");
  const [arActive, setArActive] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [trackingReady, setTrackingReady] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [shareMessage, setShareMessage] = useState("");

  const setViewerMode = useCallback((nextMode: ViewerMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  const configureObjectMode = useCallback(() => {
    repositioningRef.current = false;
    setRepositioning(false);
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    const root = modelRootRef.current;
    const floor = floorRef.current;
    const reticle = reticleRef.current;

    if (scene) scene.background = new THREE.Color(0xf4f4f2);
    if (controls) controls.enabled = true;
    if (floor) floor.visible = true;
    if (reticle) reticle.visible = false;
    if (root && modelReadyRef.current) {
      root.visible = true;
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.setScalar(1);
    }
  }, []);

  const configureArIdle = useCallback(() => {
    repositioningRef.current = false;
    setRepositioning(false);
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    const root = modelRootRef.current;
    const floor = floorRef.current;

    if (scene) scene.background = null;
    if (controls) controls.enabled = false;
    if (floor) floor.visible = false;
    if (root) root.visible = false;
  }, []);

  const resetPlacement = useCallback(() => {
    placedRef.current = false;
    trackingReadyRef.current = false;
    repositioningRef.current = false;
    placementScaleRef.current = WEBXR_FALLBACK_SCALE;
    setPlaced(false);
    setTrackingReady(false);
    setRepositioning(false);

    const root = modelRootRef.current;
    if (root) {
      root.visible = false;
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.setScalar(placementScaleRef.current);
    }
  }, []);

  const showObject = useCallback(async () => {
    setViewerMode("object");
    if (sessionRef.current) {
      try {
        await sessionRef.current.end();
      } catch {
        configureObjectMode();
      }
      return;
    }
    configureObjectMode();
  }, [configureObjectMode, setViewerMode]);

  const launchQuickLook = useCallback(() => {
    const href = quickLookUrlRef.current;
    if (!href) return;

    const anchor = document.createElement("a");
    const image = document.createElement("img");
    anchor.rel = "ar";
    anchor.href = href;
    anchor.style.position = "fixed";
    anchor.style.width = "1px";
    anchor.style.height = "1px";
    anchor.style.opacity = "0";
    anchor.style.pointerEvents = "none";
    image.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
    image.alt = "";
    anchor.appendChild(image);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const startAR = useCallback(async () => {
    if (!modelReadyRef.current) return;
    setViewerMode("ar");
    configureArIdle();

    if (arEngineRef.current === "quicklook") {
      launchQuickLook();
      return;
    }

    if (arEngineRef.current !== "webxr") return;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!renderer || !scene || sessionRef.current) return;

    const xr = (navigator as Navigator & { xr?: XRSystemLike }).xr;
    if (!xr) return;

    try {
      resetPlacement();
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType("local");
      const session = await xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay"],
        domOverlay: { root: document.body }
      });

      sessionRef.current = session;
      await renderer.xr.setSession(session);
      const viewerSpace = await session.requestReferenceSpace("viewer");
      if (!session.requestHitTestSource) throw new Error("WebXR hit-test API unavailable.");
      const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      if (!hitTestSource) throw new Error("WebXR hit-test source unavailable.");
      hitTestSourceRef.current = hitTestSource;
      scene.background = null;
      setArActive(true);

      session.addEventListener("end", () => {
        hitTestSourceRef.current?.cancel();
        hitTestSourceRef.current = null;
        sessionRef.current = null;
        setArActive(false);
        resetPlacement();
        setViewerMode("object");
        configureObjectMode();
      }, { once: true });
    } catch (startError) {
      console.error("Start WebXR AR failed", startError);
      setArActive(false);
      setError("Không thể mở camera AR. Hãy dùng HTTPS và cấp quyền camera cho trình duyệt.");
    }
  }, [configureArIdle, configureObjectMode, launchQuickLook, resetPlacement, setViewerMode]);

  const shareViewer = useCallback(async () => {
    const url = window.location.href;
    setShareMessage("");
    try {
      if (navigator.share) {
        await navigator.share({ title: modelName, text: description || `Xem model 3D ${modelName}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShareMessage("Đã sao chép liên kết");
      window.setTimeout(() => setShareMessage(""), 1800);
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setShareMessage("Không thể chia sẻ liên kết");
    }
  }, [description, modelName]);

  const closeViewer = useCallback(async () => {
    if (sessionRef.current) {
      try { await sessionRef.current.end(); } catch { /* session already closing */ }
    }
    if (window.history.length > 1) window.history.back();
    else router.push("/");
  }, [router]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.01, 100);
    camera.position.set(1.45, 0.9, 2.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    rendererRef.current = renderer;
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x737373, 2.7));
    const key = new THREE.DirectionalLight(0xffffff, 4.1);
    key.position.set(4, 7, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd7e4ff, 1.4);
    fill.position.set(-4, 3, -3);
    scene.add(fill);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 96),
      new THREE.MeshStandardMaterial({ color: 0xe9e9e6, roughness: 1, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.012;
    floor.receiveShadow = true;
    floor.visible = false;
    floorRef.current = floor;
    scene.add(floor);

    const root = new THREE.Group();
    root.visible = false;
    modelRootRef.current = root;
    scene.add(root);

    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.095, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    reticleRef.current = reticle;
    scene.add(reticle);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.minDistance = 1.15;
    controls.maxDistance = 7;
    controls.target.set(0, 0.32, 0);
    controls.enabled = false;
    controls.saveState();

    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    const tempScale = new THREE.Vector3();
    const latestSurfacePosition = new THREE.Vector3();
    const cameraPosition = new THREE.Vector3();
    const cameraForward = new THREE.Vector3();
    const cameraRight = new THREE.Vector3();
    const worldUp = new THREE.Vector3(0, 1, 0);

    const controller = renderer.xr.getController(0);
    const onSelect = () => {
      if (modeRef.current !== "ar" || placedRef.current || !reticle.visible) return;
      reticle.matrix.decompose(tempPosition, tempQuaternion, tempScale);
      root.position.copy(tempPosition);
      root.rotation.set(0, 0, 0);
      root.scale.setScalar(placementScaleRef.current);
      root.visible = true;
      reticle.visible = false;
      placedRef.current = true;
      setPlaced(true);
    };
    controller.addEventListener("select", onSelect);
    scene.add(controller);

    let gestureMode: ArGestureMode = "idle";
    let holdTimer: number | null = null;
    let gestureStartX = 0;
    let gestureStartY = 0;
    let gestureLastX = 0;
    let gestureLastY = 0;
    let gestureStartRotationY = 0;
    let gestureStartDistance = 0;
    let gestureStartScale = placementScaleRef.current;

    const clearHoldTimer = () => {
      if (holdTimer == null) return;
      window.clearTimeout(holdTimer);
      holdTimer = null;
    };

    const beginReposition = () => {
      if (!sessionRef.current || !placedRef.current || gestureMode !== "pending") return;
      gestureMode = "move";
      repositioningRef.current = true;
      setRepositioning(true);
      reticle.visible = trackingReadyRef.current;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!sessionRef.current || !placedRef.current) return;
      clearHoldTimer();
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        gestureMode = "pending";
        gestureStartX = touch.clientX;
        gestureStartY = touch.clientY;
        gestureLastX = touch.clientX;
        gestureLastY = touch.clientY;
        gestureStartRotationY = root.rotation.y;
        holdTimer = window.setTimeout(beginReposition, 260);
      } else if (event.touches.length >= 2) {
        gestureMode = "scale";
        repositioningRef.current = false;
        setRepositioning(false);
        gestureStartDistance = distanceBetweenTouches(event.touches);
        gestureStartScale = root.scale.x;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!sessionRef.current || !placedRef.current) return;

      if (event.touches.length >= 2) {
        event.preventDefault();
        clearHoldTimer();
        gestureMode = "scale";
        repositioningRef.current = false;
        setRepositioning(false);
        if (gestureStartDistance <= 0) {
          gestureStartDistance = distanceBetweenTouches(event.touches);
          gestureStartScale = root.scale.x;
          return;
        }
        const nextDistance = distanceBetweenTouches(event.touches);
        const nextScale = THREE.MathUtils.clamp(gestureStartScale * (nextDistance / gestureStartDistance), 0.08, 1.8);
        placementScaleRef.current = nextScale;
        root.scale.setScalar(nextScale);
        return;
      }

      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const totalX = touch.clientX - gestureStartX;
      const totalY = touch.clientY - gestureStartY;

      if (gestureMode === "pending" && Math.hypot(totalX, totalY) > 9) {
        clearHoldTimer();
        gestureMode = "rotate";
      }

      if (gestureMode === "rotate") {
        event.preventDefault();
        root.rotation.y = gestureStartRotationY + totalX * 0.01;
      } else if (gestureMode === "move") {
        event.preventDefault();
        const dx = touch.clientX - gestureLastX;
        const dy = touch.clientY - gestureLastY;
        const xrCamera = renderer.xr.getCamera();
        xrCamera.getWorldPosition(cameraPosition);
        xrCamera.getWorldDirection(cameraForward);
        cameraForward.y = 0;
        if (cameraForward.lengthSq() < 0.0001) cameraForward.set(0, 0, -1);
        else cameraForward.normalize();
        cameraRight.crossVectors(cameraForward, worldUp).normalize();

        const distanceToModel = Math.max(0.45, cameraPosition.distanceTo(root.position));
        const worldPerPixel = THREE.MathUtils.clamp(distanceToModel * 0.0018, 0.0008, 0.005);
        root.position.addScaledVector(cameraRight, dx * worldPerPixel);
        root.position.addScaledVector(cameraForward, -dy * worldPerPixel);
        if (trackingReadyRef.current) root.position.y = latestSurfacePosition.y;
      }

      gestureLastX = touch.clientX;
      gestureLastY = touch.clientY;
    };

    const finishGesture = () => {
      clearHoldTimer();
      if (gestureMode === "move") {
        repositioningRef.current = false;
        setRepositioning(false);
        reticle.visible = false;
      }
      gestureMode = "idle";
      gestureStartDistance = 0;
    };

    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: true });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", finishGesture, { passive: true });
    renderer.domElement.addEventListener("touchcancel", finishGesture, { passive: true });

    const prepareArEngine = async () => {
      if (disposed) return;

      if (isAppleMobile()) {
        if (usdzUrl) {
          revokeBlobUrl(quickLookUrlRef.current);
          quickLookUrlRef.current = usdzUrl;
          arEngineRef.current = "quicklook";
          setArEngine("quicklook");
          return;
        }

        arEngineRef.current = "quicklook-preparing";
        setArEngine("quicklook-preparing");

        const { exportRoot, ownedMaterials } = buildUSDZExportRoot(root);
        try {
          const exporter = new USDZExporter();
          const arrayBuffer = await exporter.parseAsync(exportRoot, {
            maxTextureSize: 2048,
            quickLookCompatible: true,
            includeAnchoringProperties: true,
            onlyVisible: true
          });
          if (disposed) return;
          if (arrayBuffer.byteLength < 1024) throw new Error("USDZ export is unexpectedly empty.");

          revokeBlobUrl(quickLookUrlRef.current);
          quickLookUrlRef.current = URL.createObjectURL(
            new Blob([arrayBuffer], { type: "model/vnd.usdz+zip" })
          );
          arEngineRef.current = "quicklook";
          setArEngine("quicklook");
        } catch (exportError) {
          console.error("Create textured USDZ for Quick Look failed", exportError);
          arEngineRef.current = "unsupported";
          setArEngine("unsupported");
        } finally {
          // Materials are clones. Textures are shared with the live GLB scene,
          // so dispose materials only and leave texture lifetime to the viewer.
          ownedMaterials.forEach((material) => material.dispose());
        }
        return;
      }

      const xr = (navigator as Navigator & { xr?: XRSystemLike }).xr;
      if (xr) {
        try {
          const supported = await xr.isSessionSupported("immersive-ar");
          if (disposed) return;
          if (supported) {
            arEngineRef.current = "webxr";
            setArEngine("webxr");
            return;
          }
        } catch {
          // Fall through to unsupported.
        }
      }

      if (!disposed) {
        arEngineRef.current = "unsupported";
        setArEngine("unsupported");
      }
    };

    const loader = new GLTFLoader();
    loader.load(
      assetUrl,
      (gltf) => {
        if (disposed) return;
        const object = gltf.scene;
        object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => {
            const typed = material as MaterialLike;
            if (typed.map) typed.map.colorSpace = THREE.SRGBColorSpace;
          });
        });

        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z) || 1;
        const normalizingScale = 1 / largest;
        object.position.set(-center.x, -box.min.y, -center.z);
        object.scale.setScalar(normalizingScale);
        normalizedModelSizeRef.current.set(
          size.x * normalizingScale,
          size.y * normalizingScale,
          size.z * normalizingScale
        );
        root.add(object);
        root.updateMatrixWorld(true);

        const normalizedHeight = normalizedModelSizeRef.current.y;
        controls.target.set(0, Math.min(0.46, Math.max(0.18, normalizedHeight * 0.48)), 0);
        camera.position.set(1.45, Math.max(0.7, normalizedHeight * 0.78), 2.6);
        controls.update();
        controls.saveState();

        modelReadyRef.current = true;
        setLoading(false);
        void prepareArEngine();
      },
      (event) => {
        if (event.total > 0) setProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      },
      (loadError) => {
        console.error(loadError);
        if (disposed) return;
        setError("Không thể đọc model. Hãy kiểm tra lại file GLB và texture của model.");
        setLoading(false);
      }
    );

    renderer.setAnimationLoop((time, frame) => {
      updateActiveModelAnimations(time);

      const inArSession = Boolean(sessionRef.current);
      controls.enabled = modeRef.current === "object" && !inArSession;
      if (controls.enabled) controls.update();

      if (frame && inArSession && hitTestSourceRef.current) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        if (referenceSpace) {
          const results = frame.getHitTestResults(hitTestSourceRef.current);
          if (results.length > 0) {
            const pose = results[0].getPose(referenceSpace);
            if (pose) {
              reticle.matrix.fromArray(pose.transform.matrix);
              reticle.matrix.decompose(tempPosition, tempQuaternion, tempScale);
              latestSurfacePosition.copy(tempPosition);
              const firstTrackingFrame = !trackingReadyRef.current;
              if (firstTrackingFrame) {
                trackingReadyRef.current = true;
                setTrackingReady(true);
              }

              if (!placedRef.current) {
                const xrCamera = getPrimaryXrCamera(renderer.xr.getCamera());
                xrCamera.getWorldPosition(cameraPosition);
                const distanceToHit = cameraPosition.distanceTo(tempPosition);
                const fittedScale = fitScaleToXrFrame(
                  xrCamera,
                  distanceToHit,
                  normalizedModelSizeRef.current
                );
                placementScaleRef.current = firstTrackingFrame
                  ? fittedScale
                  : THREE.MathUtils.lerp(placementScaleRef.current, fittedScale, 0.18);

                reticle.visible = true;
                root.visible = modelReadyRef.current;
                root.position.lerp(tempPosition, 0.38);
                root.scale.setScalar(placementScaleRef.current);
              } else {
                reticle.visible = repositioningRef.current;
              }
            }
          } else {
            reticle.visible = false;
            if (!placedRef.current) root.visible = false;
            if (trackingReadyRef.current) {
              trackingReadyRef.current = false;
              setTrackingReady(false);
            }
          }
        }
      }

      renderer.render(scene, camera);
    });

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      disposeModelAnimationsForScene(scene);
      clearHoldTimer();
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      renderer.domElement.removeEventListener("touchend", finishGesture);
      renderer.domElement.removeEventListener("touchcancel", finishGesture);
      controller.removeEventListener("select", onSelect);
      hitTestSourceRef.current?.cancel();
      hitTestSourceRef.current = null;
      void sessionRef.current?.end().catch(() => undefined);
      sessionRef.current = null;
      revokeBlobUrl(quickLookUrlRef.current);
      quickLookUrlRef.current = null;
      controls.dispose();
      scene.traverse((item) => {
        if (!(item instanceof THREE.Mesh)) return;
        item.geometry.dispose();
        const materials = Array.isArray(item.material) ? item.material : [item.material];
        materials.forEach((material) => {
          Object.keys(material).forEach((keyName) => {
            const value = (material as unknown as Record<string, unknown>)[keyName];
            if (value instanceof THREE.Texture) value.dispose();
          });
          material.dispose();
        });
      });
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      modelRootRef.current = null;
      floorRef.current = null;
      reticleRef.current = null;
    };
  }, [assetUrl, usdzUrl]);

  const arButtonLabel = arEngine === "quicklook-preparing"
    ? "Đang chuẩn bị AR…"
    : arEngine === "quicklook"
      ? "Mở AR trên iPhone"
      : arEngine === "webxr"
        ? "Bắt đầu AR"
        : arEngine === "unsupported"
          ? "AR không khả dụng"
          : "Đang kiểm tra AR…";

  return (
    <main className={styles.shell} data-mode={mode} data-ar-active={arActive ? "true" : "false"}>
      <div ref={mountRef} className={styles.canvas} />

      <header className={styles.topbar}>
        <button type="button" className={styles.roundButton} onClick={() => void closeViewer()} aria-label="Đóng viewer">
          <span aria-hidden="true">×</span>
        </button>
        <div className={styles.modeSwitch} aria-label="Chế độ xem">
          <button type="button" className={mode === "ar" ? styles.activeMode : ""} onClick={() => void startAR()}>AR</button>
          <button type="button" className={mode === "object" ? styles.activeMode : ""} onClick={() => void showObject()}>Đối tượng</button>
        </div>
        <button type="button" className={styles.roundButton} onClick={() => void shareViewer()} aria-label="Chia sẻ">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0-11 4 4m-4-4L8 7M5 11v8h14v-8" /></svg>
        </button>
      </header>

      {loading && (
        <div className={styles.loader}>
          <div className={styles.spinner} />
          <strong>Đang tải model</strong>
          <span>{progress ? `${progress}%` : "Đang chuẩn bị mô hình 3D…"}</span>
        </div>
      )}

      {error && (
        <div className={styles.errorPanel}>
          <strong>Không thể hiển thị</strong>
          <p>{error}</p>
          <button type="button" onClick={() => { setError(""); void showObject(); }}>Xem chế độ đối tượng</button>
        </div>
      )}

      {!loading && !error && mode === "ar" && !arActive && (
        <section className={styles.arLaunch}>
          <div className={styles.phonePlaneIcon} aria-hidden="true">
            <span className={styles.plane} />
            <span className={styles.phone} />
          </div>
          <strong>{arEngine === "unsupported" ? "Thiết bị này chưa hỗ trợ AR" : "Xem model trong không gian thật"}</strong>
          <p>
            {arEngine === "quicklook"
              ? "Model và texture đã được chuẩn hóa sang USDZ để mở bằng AR Quick Look."
              : arEngine === "webxr"
                ? "Model sẽ tự căn theo khung hình. Chạm để đặt, giữ-kéo để di chuyển, vuốt để xoay và chụm để đổi kích thước."
                : arEngine === "quicklook-preparing"
                  ? "Đang chuyển geometry, material và texture sang USDZ cho iPhone."
                  : arEngine === "unsupported"
                    ? "Bạn vẫn có thể xem model trong chế độ Đối tượng."
                    : "Đang kiểm tra khả năng AR của trình duyệt…"}
          </p>
          <button
            type="button"
            className={styles.arButton}
            disabled={arEngine === "checking" || arEngine === "quicklook-preparing" || arEngine === "unsupported"}
            onClick={() => void startAR()}
          >
            {arButtonLabel}
          </button>
        </section>
      )}

      {!loading && !error && mode === "ar" && arActive && !placed && (
        <div className={styles.arInstruction}>
          <div className={styles.phonePlaneIcon} aria-hidden="true">
            <span className={styles.plane} />
            <span className={styles.phone} />
          </div>
          <strong>{trackingReady ? "Chạm để đặt model" : "Di chuyển điện thoại để tìm mặt phẳng"}</strong>
          <span>{trackingReady ? "Model đang tự căn kích thước theo khung hình." : "Hướng camera xuống sàn hoặc mặt bàn."}</span>
        </div>
      )}

      {!loading && !error && mode === "ar" && arActive && placed && repositioning && (
        <div className={styles.arHint}>Đang di chuyển model · thả tay để cố định</div>
      )}

      {shareMessage && <div className={styles.toast}>{shareMessage}</div>}

      <p className={styles.srOnly} aria-live="polite">
        {mode === "object" ? "Chế độ xem đối tượng" : arActive ? "Chế độ thực tế tăng cường đang hoạt động" : "Chế độ thực tế tăng cường"}
      </p>
    </main>
  );
}
