"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type ViewerMode = "touch" | "motion";
type OrientationPermissionEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
};

const toRad = THREE.MathUtils.degToRad;

function shortestAngle(current: number, start: number) {
  let delta = current - start;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

export function ModelViewer({ modelName, description, assetUrl }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const targetRotationRef = useRef(new THREE.Euler(0, 0, 0, "YXZ"));
  const baselineRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const [mode, setMode] = useState<ViewerMode>("touch");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [motionMessage, setMotionMessage] = useState("");
  const modeRef = useRef<ViewerMode>(mode);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const resetView = useCallback(() => {
    baselineRef.current = null;
    targetRotationRef.current.set(0, 0, 0);
    rootRef.current?.rotation.set(0, 0, 0);
    controlsRef.current?.reset();
  }, []);

  const enterFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) await mountRef.current?.requestFullscreen?.();
    else await document.exitFullscreen();
  }, []);

  const enableMotion = useCallback(async () => {
    setMotionMessage("");
    if (!("DeviceOrientationEvent" in window)) {
      setMotionMessage("Thiết bị không hỗ trợ cảm biến hướng. Đã giữ chế độ chạm.");
      setMode("touch");
      return;
    }

    const orientationEvent = DeviceOrientationEvent as OrientationPermissionEvent;
    if (typeof orientationEvent.requestPermission === "function") {
      try {
        const permission = await orientationEvent.requestPermission();
        if (permission !== "granted") {
          setMotionMessage("Bạn chưa cấp quyền cảm biến chuyển động.");
          setMode("touch");
          return;
        }
      } catch {
        setMotionMessage("Không thể kích hoạt cảm biến. Hãy mở trang bằng HTTPS.");
        setMode("touch");
        return;
      }
    }

    baselineRef.current = null;
    setMode("motion");
  }, []);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0f13);

    const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.01, 1000);
    camera.position.set(0, 0.35, 4.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.prepend(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xdce9ff, 0x211b18, 2.2);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(4, 6, 5);
    key.castShadow = true;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb5ff, 2.4);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 96),
      new THREE.MeshStandardMaterial({ color: 0x171a20, roughness: 0.9, metalness: 0.05 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.25;
    floor.receiveShadow = true;
    scene.add(floor);

    const root = new THREE.Group();
    rootRef.current = root;
    scene.add(root);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.minDistance = 1.2;
    controls.maxDistance = 10;
    controls.target.set(0, 0, 0);
    controls.saveState();

    const loader = new GLTFLoader();
    loader.load(
      assetUrl,
      (gltf) => {
        const object = gltf.scene;
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material) => {
              if ("map" in material && material.map instanceof THREE.Texture) {
                material.map.colorSpace = THREE.SRGBColorSpace;
              }
            });
          }
        });

        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        const largest = Math.max(size.x, size.y, size.z) || 1;
        const scale = 2.3 / largest;
        object.scale.setScalar(scale);
        root.add(object);

        const scaledHeight = size.y * scale;
        floor.position.y = -scaledHeight / 2 - 0.08;
        camera.position.set(0, Math.max(0.15, scaledHeight * 0.08), 4.25);
        controls.target.set(0, 0, 0);
        controls.update();
        controls.saveState();
        setLoading(false);
      },
      (event) => {
        if (event.total > 0) setProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      },
      (loadError) => {
        console.error(loadError);
        setError("Không thể đọc model. Hãy kiểm tra lại file GLB.");
        setLoading(false);
      }
    );

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (modeRef.current !== "motion" || event.alpha == null || event.beta == null || event.gamma == null) return;
      if (!baselineRef.current) {
        baselineRef.current = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
        return;
      }
      const baseline = baselineRef.current;
      const yaw = shortestAngle(event.alpha, baseline.alpha);
      const pitch = event.beta - baseline.beta;
      const roll = event.gamma - baseline.gamma;
      targetRotationRef.current.set(
        THREE.MathUtils.clamp(toRad(pitch) * 0.85, -1.15, 1.15),
        toRad(yaw) * 1.1,
        THREE.MathUtils.clamp(-toRad(roll) * 0.45, -0.55, 0.55),
        "YXZ"
      );
    };
    window.addEventListener("deviceorientation", onOrientation, true);

    let frame = 0;
    const clock = new THREE.Clock();
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      controls.enabled = modeRef.current === "touch";
      if (controls.enabled) controls.update();
      if (modeRef.current === "motion") {
        const factor = 1 - Math.exp(-8 * delta);
        root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, targetRotationRef.current.x, factor);
        root.rotation.y = THREE.MathUtils.lerp(root.rotation.y, targetRotationRef.current.y, factor);
        root.rotation.z = THREE.MathUtils.lerp(root.rotation.z, targetRotationRef.current.z, factor);
      }
      renderer.render(scene, camera);
    };
    animate();

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
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("deviceorientation", onOrientation, true);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            Object.keys(material).forEach((key) => {
              const value = (material as unknown as Record<string, unknown>)[key];
              if (value instanceof THREE.Texture) value.dispose();
            });
            material.dispose();
          });
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      rootRef.current = null;
      controlsRef.current = null;
    };
  }, [assetUrl]);

  return (
    <main className="viewer-shell">
      <div ref={mountRef} className="viewer-canvas" />

      <header className="viewer-header">
        <Link href="/" className="viewer-brand">MS</Link>
        <div><h1>{modelName}</h1>{description && <p>{description}</p>}</div>
        <button type="button" className="icon-button" onClick={() => void enterFullscreen()} aria-label="Toàn màn hình">⛶</button>
      </header>

      {loading && <div className="viewer-loader"><div className="loader-ring" /><strong>Đang tải model</strong><span>{progress ? `${progress}%` : "Đang chuẩn bị không gian 3D…"}</span></div>}
      {error && <div className="viewer-error"><strong>Không thể hiển thị</strong><p>{error}</p></div>}

      <aside className="viewer-hint">
        <span>{mode === "touch" ? "Dùng một ngón để xoay · hai ngón để thu phóng" : "Di chuyển điện thoại để quan sát model"}</span>
        {motionMessage && <small>{motionMessage}</small>}
      </aside>

      <div className="viewer-toolbar">
        <button type="button" className={mode === "touch" ? "active" : ""} onClick={() => setMode("touch")}><span>✦</span><small>Chạm</small></button>
        <button type="button" className={mode === "motion" ? "active" : ""} onClick={() => void enableMotion()}><span>◉</span><small>Chuyển động</small></button>
        <button type="button" onClick={resetView}><span>↺</span><small>Đặt lại</small></button>
      </div>
    </main>
  );
}
