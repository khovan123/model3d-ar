"use client";

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";

export type ModelSpaceDebugLevel = "debug" | "info" | "warn" | "error";
export type ModelSpaceDebugCategory =
  | "BOOT"
  | "GLOBAL"
  | "NETWORK"
  | "GLB"
  | "ANIMATION"
  | "RENDER"
  | "WEBXR"
  | "INTERACTION"
  | "AUDIO"
  | "USDZ"
  | "TEXTURE"
  | "CONSOLE";

export type ModelSpaceDebugEntry = {
  id: number;
  at: string;
  elapsedMs: number;
  level: ModelSpaceDebugLevel;
  category: ModelSpaceDebugCategory;
  event: string;
  data?: unknown;
};

type DebugWindow = Window & {
  __MODELSPACE_DEBUG__?: ModelSpaceDebugEntry[];
  __MODELSPACE_DEBUG_EXPORT__?: () => string;
  __MODELSPACE_DEBUG_CLEAR__?: () => void;
  __MODELSPACE_DEBUG_SNAPSHOT__?: () => Record<string, unknown>;
};

type AnimationMixerPrivate = THREE.AnimationMixer & {
  _actions?: Array<{
    enabled?: boolean;
    paused?: boolean;
    time?: number;
    timeScale?: number;
    weight?: number;
    getClip?: () => THREE.AnimationClip;
  }>;
};

type XRSystemLike = {
  requestSession?: (mode: string, options?: Record<string, unknown>) => Promise<unknown>;
};

type XRSessionLike = EventTarget & {
  requestReferenceSpace?: (type: string) => Promise<unknown>;
  requestHitTestSource?: (options: Record<string, unknown>) => Promise<unknown>;
  enabledFeatures?: Iterable<string>;
  visibilityState?: string;
};

const MAX_LOGS = 800;
const STARTED_AT = typeof performance !== "undefined" ? performance.now() : Date.now();
const DEBUG_EVENT = "modelspace:debug-log";
const mixers = new Map<string, { mixer: AnimationMixerPrivate; lastUpdateAt: number; updates: number; lastDelta: number }>();
const glbScenes = new Map<string, { url: string; clips: number; tracks: number; loadedAt: number }>();
const renderers = new Map<string, { frames: number; firstFrameAt: number; lastFrameAt: number; xrPresenting: boolean }>();

let sequence = 0;
let installed = false;
let healthTimer = 0;
let consoleInstalled = false;

const nativeConsole = {
  debug: typeof console !== "undefined" ? console.debug.bind(console) : () => undefined,
  info: typeof console !== "undefined" ? console.info.bind(console) : () => undefined,
  warn: typeof console !== "undefined" ? console.warn.bind(console) : () => undefined,
  error: typeof console !== "undefined" ? console.error.bind(console) : () => undefined
};

function safeValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3 || value instanceof THREE.Vector4 || value instanceof THREE.Euler) {
    return value.toArray();
  }
  if (value instanceof THREE.Quaternion) return value.toArray();
  if (value instanceof THREE.Object3D) {
    return {
      type: value.type,
      name: value.name,
      uuid: value.uuid,
      visible: value.visible,
      children: value.children.length,
      position: value.position.toArray(),
      quaternion: value.quaternion.toArray(),
      scale: value.scale.toArray()
    };
  }
  if (depth >= 3) return String(value);
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      try { output[key] = safeValue(item, depth + 1); } catch { output[key] = "[unserializable]"; }
    }
    return output;
  }
  return String(value);
}

function getStore() {
  if (typeof window === "undefined") return [] as ModelSpaceDebugEntry[];
  const debugWindow = window as DebugWindow;
  debugWindow.__MODELSPACE_DEBUG__ ??= [];
  return debugWindow.__MODELSPACE_DEBUG__;
}

export function modelSpaceDebug(
  category: ModelSpaceDebugCategory,
  event: string,
  data?: unknown,
  level: ModelSpaceDebugLevel = "info"
) {
  const elapsedMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - STARTED_AT);
  const entry: ModelSpaceDebugEntry = {
    id: ++sequence,
    at: new Date().toISOString(),
    elapsedMs,
    level,
    category,
    event,
    ...(data === undefined ? {} : { data: safeValue(data) })
  };

  const store = getStore();
  store.push(entry);
  if (store.length > MAX_LOGS) store.splice(0, store.length - MAX_LOGS);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DEBUG_EVENT, { detail: entry }));
  }

  const method = level === "error" ? nativeConsole.error : level === "warn" ? nativeConsole.warn : level === "debug" ? nativeConsole.debug : nativeConsole.info;
  method(`[ModelSpace:${category}] ${event}`, entry.data ?? "");
  return entry;
}

export function getModelSpaceDebugLogs() {
  return [...getStore()];
}

export function clearModelSpaceDebugLogs() {
  getStore().splice(0);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DEBUG_EVENT));
}

export function exportModelSpaceDebugLogs() {
  const payload = {
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "server",
    url: typeof location !== "undefined" ? location.href : "server",
    snapshot: createRuntimeSnapshot(),
    logs: getModelSpaceDebugLogs()
  };
  return JSON.stringify(payload, null, 2);
}

function describeTrack(track: THREE.KeyframeTrack) {
  let binding: unknown = null;
  try { binding = THREE.PropertyBinding.parseTrackName(track.name); } catch { /* invalid track is logged by name */ }
  return {
    name: track.name,
    type: track.ValueTypeName,
    times: track.times.length,
    values: track.values.length,
    start: track.times.length ? track.times[0] : null,
    end: track.times.length ? track.times[track.times.length - 1] : null,
    binding
  };
}

function describeClip(clip: THREE.AnimationClip) {
  return {
    name: clip.name || "Unnamed",
    uuid: clip.uuid,
    duration: clip.duration,
    tracks: clip.tracks.length,
    trackDetails: clip.tracks.map(describeTrack)
  };
}

function inspectScene(scene: THREE.Object3D) {
  let meshes = 0;
  let skinnedMeshes = 0;
  let bones = 0;
  let morphMeshes = 0;
  let materials = 0;
  let textures = 0;
  scene.traverse((object) => {
    if (object instanceof THREE.Bone) bones += 1;
    if (!(object instanceof THREE.Mesh)) return;
    meshes += 1;
    if (object instanceof THREE.SkinnedMesh) skinnedMeshes += 1;
    if (object.morphTargetInfluences && object.morphTargetInfluences.length > 0) morphMeshes += 1;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    materials += list.length;
    for (const material of list) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures += 1;
    }
  });
  return { meshes, skinnedMeshes, bones, morphMeshes, materials, textures };
}

function createRuntimeSnapshot() {
  return {
    mixers: Array.from(mixers.entries()).map(([id, state]) => ({
      id,
      time: state.mixer.time,
      updates: state.updates,
      lastDelta: state.lastDelta,
      msSinceUpdate: Math.round(performance.now() - state.lastUpdateAt),
      actions: state.mixer._actions?.map((action) => ({
        clip: action.getClip?.().name,
        enabled: action.enabled,
        paused: action.paused,
        time: action.time,
        timeScale: action.timeScale,
        weight: action.weight
      })) ?? []
    })),
    glbScenes: Array.from(glbScenes.entries()).map(([uuid, state]) => ({ uuid, ...state })),
    renderers: Array.from(renderers.entries()).map(([uuid, state]) => ({ uuid, ...state })),
    visibility: typeof document !== "undefined" ? document.visibilityState : "unknown"
  };
}

function installConsoleCapture() {
  if (consoleInstalled || typeof console === "undefined") return;
  consoleInstalled = true;

  const install = (level: ModelSpaceDebugLevel) => {
    const original = nativeConsole[level];
    console[level] = (...args: unknown[]) => {
      original(...args);
      const first = typeof args[0] === "string" ? args[0] : "";
      if (first.startsWith("[ModelSpace:")) return;
      const looksRelevant = first.includes("ModelSpace") || first.includes("Three") || first.includes("WebXR") || first.includes("USDZ") || first.includes("GLTF") || first.includes("audio") || level === "error";
      if (!looksRelevant) return;
      const entry: ModelSpaceDebugEntry = {
        id: ++sequence,
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - STARTED_AT),
        level,
        category: "CONSOLE",
        event: first || "console",
        data: safeValue(args.slice(1))
      };
      const store = getStore();
      store.push(entry);
      if (store.length > MAX_LOGS) store.splice(0, store.length - MAX_LOGS);
      window.dispatchEvent(new CustomEvent(DEBUG_EVENT, { detail: entry }));
    };
  };

  install("debug");
  install("info");
  install("warn");
  install("error");
}

function installGlobalErrorCapture() {
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLMediaElement) {
      modelSpaceDebug("AUDIO", "media-error", {
        src: target.currentSrc || target.src,
        code: target.error?.code,
        message: target.error?.message,
        networkState: target.networkState,
        readyState: target.readyState
      }, "error");
      return;
    }
    modelSpaceDebug("GLOBAL", "window-error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error
    }, "error");
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    modelSpaceDebug("GLOBAL", "unhandled-rejection", { reason: event.reason }, "error");
  });

  document.addEventListener("visibilitychange", () => {
    modelSpaceDebug("GLOBAL", "visibility-change", { state: document.visibilityState }, "debug");
  });

  document.addEventListener("pointerup", (event) => {
    modelSpaceDebug("INTERACTION", "pointer-up", {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
      target: event.target instanceof Element ? `${event.target.tagName}.${event.target.className}` : String(event.target)
    }, "debug");
  }, true);

  document.addEventListener("touchend", (event) => {
    modelSpaceDebug("INTERACTION", "touch-end", {
      touches: event.touches.length,
      changedTouches: event.changedTouches.length
    }, "debug");
  }, true);

  document.addEventListener("play", (event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement) modelSpaceDebug("AUDIO", "play", { src: media.currentSrc || media.src, currentTime: media.currentTime });
  }, true);
  document.addEventListener("pause", (event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement) modelSpaceDebug("AUDIO", "pause", { src: media.currentSrc || media.src, currentTime: media.currentTime }, "debug");
  }, true);
}

function installFetchCapture() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = performance.now();
    const relevant = url.includes("/api/models") || url.includes("/api/assets") || url.includes("supabase") || url.includes(".glb") || url.includes("audio");
    if (relevant) modelSpaceDebug("NETWORK", "request", { method, url }, "debug");
    try {
      const response = await originalFetch(input, init);
      if (relevant || !response.ok) {
        modelSpaceDebug("NETWORK", response.ok ? "response" : "http-error", {
          method,
          url,
          status: response.status,
          contentType: response.headers.get("content-type"),
          durationMs: Math.round(performance.now() - started)
        }, response.ok ? "debug" : "error");
      }
      return response;
    } catch (error) {
      modelSpaceDebug("NETWORK", "fetch-failed", { method, url, durationMs: Math.round(performance.now() - started), error }, "error");
      throw error;
    }
  };
}

function installGLTFCapture() {
  const prototype = GLTFLoader.prototype as GLTFLoader & { __modelSpaceDebugPatch?: boolean };
  if (prototype.__modelSpaceDebugPatch) return;
  prototype.__modelSpaceDebugPatch = true;

  const originalLoad = GLTFLoader.prototype.load;
  type Args = Parameters<GLTFLoader["load"]>;
  type Loaded = Parameters<NonNullable<Args[1]>>[0];

  GLTFLoader.prototype.load = function (url: Args[0], onLoad: Args[1], onProgress?: Args[2], onError?: Args[3]) {
    const requestUrl = String(url);
    const started = performance.now();
    modelSpaceDebug("GLB", "load-start", { url: requestUrl });

    const wrappedLoad = (gltf: Loaded) => {
      const totalTracks = gltf.animations.reduce((sum, clip) => sum + clip.tracks.length, 0);
      glbScenes.set(gltf.scene.uuid, { url: requestUrl, clips: gltf.animations.length, tracks: totalTracks, loadedAt: performance.now() });
      modelSpaceDebug("GLB", "load-success", {
        url: requestUrl,
        durationMs: Math.round(performance.now() - started),
        scene: inspectScene(gltf.scene),
        animationCount: gltf.animations.length,
        animations: gltf.animations.map(describeClip)
      });
      onLoad(gltf);
    };

    const wrappedError = (error: unknown) => {
      modelSpaceDebug("GLB", "load-failed", { url: requestUrl, durationMs: Math.round(performance.now() - started), error }, "error");
      onError?.(error);
    };

    return originalLoad.call(this, url, wrappedLoad, onProgress, wrappedError);
  };
}

function installAnimationCapture() {
  const mixerPrototype = THREE.AnimationMixer.prototype as THREE.AnimationMixer & { __modelSpaceDebugPatch?: boolean };
  if (!mixerPrototype.__modelSpaceDebugPatch) {
    mixerPrototype.__modelSpaceDebugPatch = true;
    const originalClipAction = THREE.AnimationMixer.prototype.clipAction;
    const originalUpdate = THREE.AnimationMixer.prototype.update;

    THREE.AnimationMixer.prototype.clipAction = function (...args: Parameters<THREE.AnimationMixer["clipAction"]>) {
      const action = originalClipAction.apply(this, args);
      const clip = typeof args[0] === "string" ? THREE.AnimationClip.findByName(this.getRoot(), args[0]) : args[0];
      modelSpaceDebug("ANIMATION", "clip-action", {
        mixerRoot: this.getRoot(),
        clip: clip instanceof THREE.AnimationClip ? describeClip(clip) : String(args[0])
      });
      return action;
    };

    THREE.AnimationMixer.prototype.update = function (deltaTime: number) {
      const id = this.getRoot().uuid;
      let state = mixers.get(id);
      if (!state) {
        state = { mixer: this as AnimationMixerPrivate, lastUpdateAt: performance.now(), updates: 0, lastDelta: 0 };
        mixers.set(id, state);
        modelSpaceDebug("ANIMATION", "mixer-registered", { root: this.getRoot(), mixerTime: this.time });
      }
      state.lastUpdateAt = performance.now();
      state.updates += 1;
      state.lastDelta = deltaTime;
      try {
        return originalUpdate.call(this, deltaTime);
      } catch (error) {
        modelSpaceDebug("ANIMATION", "mixer-update-failed", { root: this.getRoot(), deltaTime, error }, "error");
        throw error;
      }
    };
  }
}

function installRenderCapture() {
  const prototype = THREE.WebGLRenderer.prototype as THREE.WebGLRenderer & { __modelSpaceDebugPatch?: boolean };
  if (prototype.__modelSpaceDebugPatch) return;
  prototype.__modelSpaceDebugPatch = true;
  const originalRender = THREE.WebGLRenderer.prototype.render;

  THREE.WebGLRenderer.prototype.render = function (scene: THREE.Object3D, camera: THREE.Camera) {
    let state = renderers.get(this.uuid);
    const now = performance.now();
    if (!state) {
      state = { frames: 0, firstFrameAt: now, lastFrameAt: now, xrPresenting: this.xr.isPresenting };
      renderers.set(this.uuid, state);
      modelSpaceDebug("RENDER", "renderer-first-frame", {
        renderer: this.uuid,
        xrPresenting: this.xr.isPresenting,
        sceneChildren: scene.children.length,
        camera: camera.type
      });
    }
    state.frames += 1;
    state.lastFrameAt = now;
    if (state.xrPresenting !== this.xr.isPresenting) {
      state.xrPresenting = this.xr.isPresenting;
      modelSpaceDebug("RENDER", "xr-render-state", { renderer: this.uuid, xrPresenting: this.xr.isPresenting });
    }
    try {
      return originalRender.call(this, scene, camera);
    } catch (error) {
      modelSpaceDebug("RENDER", "render-failed", { renderer: this.uuid, error }, "error");
      throw error;
    }
  };
}

function installUSDZCapture() {
  const prototype = USDZExporter.prototype as USDZExporter & { __modelSpaceDebugPatch?: boolean };
  if (prototype.__modelSpaceDebugPatch) return;
  prototype.__modelSpaceDebugPatch = true;
  const originalParseAsync = USDZExporter.prototype.parseAsync;

  USDZExporter.prototype.parseAsync = async function (scene: THREE.Object3D, options?: Parameters<USDZExporter["parseAsync"]>[1]) {
    const started = performance.now();
    modelSpaceDebug("USDZ", "export-start", { scene: inspectScene(scene), options, root: scene });
    try {
      const result = await originalParseAsync.call(this, scene, options);
      modelSpaceDebug("USDZ", "export-success", {
        durationMs: Math.round(performance.now() - started),
        bytes: result.byteLength,
        scene: inspectScene(scene)
      });
      return result;
    } catch (error) {
      modelSpaceDebug("USDZ", "export-failed", { durationMs: Math.round(performance.now() - started), error }, "error");
      throw error;
    }
  };
}

function installWebXRCapture() {
  const xr = (navigator as Navigator & { xr?: XRSystemLike }).xr;
  if (!xr?.requestSession) {
    modelSpaceDebug("WEBXR", "api-unavailable", { userAgent: navigator.userAgent }, "warn");
    return;
  }

  const xrObject = xr as XRSystemLike & { __modelSpaceDebugPatch?: boolean };
  if (xrObject.__modelSpaceDebugPatch) return;
  xrObject.__modelSpaceDebugPatch = true;
  const originalRequestSession = xr.requestSession.bind(xr);

  xrObject.requestSession = async (mode: string, options?: Record<string, unknown>) => {
    modelSpaceDebug("WEBXR", "request-session", { mode, options });
    try {
      const rawSession = await originalRequestSession(mode, options);
      const session = rawSession as XRSessionLike;
      modelSpaceDebug("WEBXR", "session-started", {
        mode,
        enabledFeatures: session.enabledFeatures ? Array.from(session.enabledFeatures) : [],
        visibilityState: session.visibilityState,
        hasHitTest: typeof session.requestHitTestSource === "function"
      });

      session.addEventListener("end", () => modelSpaceDebug("WEBXR", "session-ended", { mode }));
      session.addEventListener("visibilitychange", () => modelSpaceDebug("WEBXR", "session-visibility", { state: session.visibilityState }, "debug"));

      if (session.requestReferenceSpace) {
        const originalRequestReferenceSpace = session.requestReferenceSpace.bind(session);
        session.requestReferenceSpace = async (type: string) => {
          modelSpaceDebug("WEBXR", "reference-space-request", { type }, "debug");
          try {
            const space = await originalRequestReferenceSpace(type);
            modelSpaceDebug("WEBXR", "reference-space-ready", { type }, "debug");
            return space;
          } catch (error) {
            modelSpaceDebug("WEBXR", "reference-space-failed", { type, error }, "error");
            throw error;
          }
        };
      }

      if (session.requestHitTestSource) {
        const originalRequestHitTestSource = session.requestHitTestSource.bind(session);
        session.requestHitTestSource = async (hitOptions: Record<string, unknown>) => {
          modelSpaceDebug("WEBXR", "hit-test-source-request", hitOptions);
          try {
            const source = await originalRequestHitTestSource(hitOptions);
            modelSpaceDebug("WEBXR", "hit-test-source-ready");
            return source;
          } catch (error) {
            modelSpaceDebug("WEBXR", "hit-test-source-failed", { error }, "error");
            throw error;
          }
        };
      }

      return rawSession;
    } catch (error) {
      modelSpaceDebug("WEBXR", "request-session-failed", { mode, options, error }, "error");
      throw error;
    }
  };
}

function installHealthChecks() {
  if (healthTimer) return;
  healthTimer = window.setInterval(() => {
    const now = performance.now();
    for (const [id, state] of mixers) {
      const silentFor = now - state.lastUpdateAt;
      if (silentFor > 2500) {
        modelSpaceDebug("ANIMATION", "mixer-stalled", {
          rootUuid: id,
          silentForMs: Math.round(silentFor),
          updates: state.updates,
          mixerTime: state.mixer.time,
          actions: state.mixer._actions?.map((action) => ({
            clip: action.getClip?.().name,
            enabled: action.enabled,
            paused: action.paused,
            time: action.time,
            timeScale: action.timeScale,
            weight: action.weight
          })) ?? []
        }, "warn");
      }
    }

    for (const [id, state] of renderers) {
      if (state.frames > 0 && now - state.lastFrameAt > 2500 && document.visibilityState === "visible") {
        modelSpaceDebug("RENDER", "render-loop-stalled", { renderer: id, silentForMs: Math.round(now - state.lastFrameAt), frames: state.frames }, "warn");
      }
    }
  }, 2500);
}

export function installModelSpaceDebugging() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const debugWindow = window as DebugWindow;
  debugWindow.__MODELSPACE_DEBUG__ = getStore();
  debugWindow.__MODELSPACE_DEBUG_EXPORT__ = exportModelSpaceDebugLogs;
  debugWindow.__MODELSPACE_DEBUG_CLEAR__ = clearModelSpaceDebugLogs;
  debugWindow.__MODELSPACE_DEBUG_SNAPSHOT__ = createRuntimeSnapshot;

  installConsoleCapture();
  installGlobalErrorCapture();
  installFetchCapture();
  installGLTFCapture();
  installAnimationCapture();
  installRenderCapture();
  installUSDZCapture();
  installWebXRCapture();
  installHealthChecks();

  modelSpaceDebug("BOOT", "debugger-installed", {
    url: location.href,
    debugPanel: new URLSearchParams(location.search).get("debug") === "1",
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    devicePixelRatio: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    webgl: true,
    webxr: Boolean((navigator as Navigator & { xr?: unknown }).xr)
  });
}

export const MODELSPACE_DEBUG_EVENT = DEBUG_EVENT;
