"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import styles from "./model-viewer.module.css";

type ViewerMode = "ar" | "object";
type ArEngine = "checking" | "webxr" | "quicklook-preparing" | "quicklook" | "unsupported";
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
};

function isAppleMobile() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function supportsQuickLook() {
  try {
    const anchor = document.createElement("a");
    return typeof anchor.relList?.supports === "function" && anchor.relList.supports("ar");
  } catch {
    return false;
  }
}

function distanceBetweenTouches(touches: TouchList) {
  if (touches.length < 2) return 0;
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

export function ModelViewer({ modelName, description, assetUrl }: Props) {
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
  const placementScaleRef = useRef(0.45);

  const [mode, setMode] = useState<ViewerMode>("ar");
  const [arEngine, setArEngine] = useState<ArEngine>("checking");
  const [arActive, setArActive] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [trackingReady, setTrackingReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [shareMessage, setShareMessage] = useState("");

  const setViewerMode = useCallback((nextMode: ViewerMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  const configureObjectMode = useCallback(() => {
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
    placementScaleRef.current = 0.45;
    setPlaced(false);
    setTrackingReady(false);

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
      if (!session.requestHitTestSource) throw new Error("WebXR hit-test API is unavailable.");
      const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      if (!hitTestSource) throw new Error("WebXR did not return a hit-test source.");
      hitTestSourceRef.current = hitTestSource;
      scene.background = null;
      setArActive(true);

      const handleEnd = () => {
        hitTestSourceRef.current?.cancel();
        hitTestSourceRef.current = null;
        sessionRef.current = null;
        setArActive(false);
        resetPlacement();
        setViewerMode("object");
        configureObjectMode();
      };
      session.addEventListener("end", handleEnd, { once: true });
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
      try {
        await sessionRef.current.end();
      } catch {
        // Continue navigation even if the XR session is already closing.
      }
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

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x737373, 2.7);
    scene.add(hemisphere);
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

    let gestureStartX = 0;
    let gestureStartRotationY = 0;
    let gestureStartDistance = 0;
    let gestureStartScale = placementScaleRef.current;

    const onTouchStart = (event: TouchEvent) => {
      if (!sessionRef.current || !placedRef.current) return;
      if (event.touches.length === 1) {
        gestureStartX = event.touches[0].clientX;
        gestureStartRotationY = root.rotation.y;
      } else if (event.touches.length >= 2) {
        gestureStartDistance = distanceBetweenTouches(event.touches);
        gestureStartScale = root.scale.x;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!sessionRef.current || !placedRef.current) return;
      event.preventDefault();
      if (event.touches.length === 1) {
        const deltaX = event.touches[0].clientX - gestureStartX;
        root.rotation.y = gestureStartRotationY + deltaX * 0.01;
      } else if (event.touches.length >= 2 && gestureStartDistance > 0) {
        const nextDistance = distanceBetweenTouches(event.touches);
        const nextScale = THREE.MathUtils.clamp(gestureStartScale * (nextDistance / gestureStartDistance), 0.12, 1.8);
        placementScaleRef.current = nextScale;
        root.scale.setScalar(nextScale);
      }
    };

    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: true });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });

    const prepareArEngine = async () => {
      if (disposed) return;

      if (isAppleMobile() && supportsQuickLook()) {
        arEngineRef.current = "quicklook-preparing";
        setArEngine("quicklook-preparing");
        try {
          root.updateMatrixWorld(true);
          const exporter = new USDZExporter();
          const arrayBuffer = await exporter.parseAsync(root, {
            maxTextureSize: 1024,
            quickLookCompatible: true,
            includeAnchoringProperties: true
          });
          if (disposed) return;
          const blobUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: "model/vnd.usdz+zip" }));
          quickLookUrlRef.current = blobUrl;
          arEngineRef.current = "quicklook";
          setArEngine("quicklook");
        } catch (exportError) {
          console.error("Create USDZ for AR Quick Look failed", exportError);
          arEngineRef.current = "unsupported";
          setArEngine("unsupported");
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
          // Fall through to unsupported state.
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
            if ("map" in material && material.map instanceof THREE.Texture) material.map.colorSpace = THREE.SRGBColorSpace;
          });
        });

        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z) || 1;
        const normalizingScale = 1 / largest;
        object.position.set(-center.x, -box.min.y, -center.z);
        object.scale.setScalar(normalizingScale);
        root.add(object);
        root.updateMatrixWorld(true);

        const normalizedHeight = size.y * normalizingScale;
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

    renderer.setAnimationLoop((_time, frame) => {
      const inArSession = Boolean(sessionRef.current);
      controls.enabled = modeRef.current === "object" && !inArSession;
      if (controls.enabled) controls.update();

      if (frame && inArSession && hitTestSourceRef.current && !placedRef.current) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        if (referenceSpace) {
          const results = frame.getHitTestResults(hitTestSourceRef.current);
          if (results.length > 0) {
            const pose = results[0].getPose(referenceSpace);
            if (pose) {
              reticle.visible = true;
              reticle.matrix.fromArray(pose.transform.matrix);
              if (!trackingReadyRef.current) {
                trackingReadyRef.current = true;
                setTrackingReady(true);
              }
            }
          } else {
            reticle.visible = false;
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
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      controller.removeEventListener("select", onSelect);
      hitTestSourceRef.current?.cancel();
      hitTestSourceRef.current = null;
      void sessionRef.current?.end().catch(() => undefined);
      sessionRef.current = null;
      if (quickLookUrlRef.current) URL.revokeObjectURL(quickLookUrlRef.current);
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
  }, [assetUrl]);

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
    <main className={styles.shell} data-mode={mode}>
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
              ? "AR sẽ mở bằng Quick Look để đặt model lên mặt phẳng và tương tác trực tiếp bằng tay."
              : arEngine === "webxr"
                ? "Camera sẽ tìm mặt phẳng thực tế. Di chuyển điện thoại, chạm để đặt model rồi xoay hoặc thu phóng bằng tay."
                : arEngine === "quicklook-preparing"
                  ? "Đang chuyển GLB sang USDZ bằng Three.js để mở AR Quick Look trên iPhone."
                  : arEngine === "unsupported"
                    ? "Bạn vẫn có thể xoay và thu phóng model trong chế độ Đối tượng."
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
          <strong>{trackingReady ? "Chạm để đặt mô hình" : "Di chuyển điện thoại để bắt đầu"}</strong>
          <span>{trackingReady ? "Đã tìm thấy mặt phẳng" : "Hướng camera xuống sàn hoặc mặt bàn"}</span>
        </div>
      )}

      {!loading && !error && mode === "ar" && arActive && placed && (
        <div className={styles.gestureHint}>Di chuyển điện thoại để đổi góc nhìn · vuốt model để xoay · chụm hai ngón để đổi kích thước</div>
      )}

      {!loading && !error && mode === "object" && (
        <div className={styles.objectHint}>Vuốt để xoay · chụm hai ngón để thu phóng</div>
      )}

      {shareMessage && <div className={styles.toast}>{shareMessage}</div>}
      <span className={styles.srOnly}>{modelName}. {description}</span>
    </main>
  );
}
