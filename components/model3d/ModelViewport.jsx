'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

/**
 * Three.js canvas for the 3D Viewer page. Owns the renderer, camera, lights
 * and AnimationMixer; the page drives it through props and reads back
 * metadata via onLoaded / onTime.
 *
 * Props:
 * - model: { url, ext, name, id } | null — the model currently on screen
 * - openIds: string[] — every model still open in the sidebar; cached scenes
 *   for ids that disappear from this list are disposed
 * - startTime: number — clip time to restore when the model finishes loading
 * - playing, clipIndex, speed, wireframe, autoRotate, showGrid, showAxes, bg
 * - seekRequest: { time, nonce } | null — jump the mixer to `time`
 * - resetSignal: number — change to refit + reset the camera
 *
 * Callbacks carry the model id so the page can keep per-model state while the
 * user switches between loaded models.
 * - onLoaded(id, stats, clips)
 * - onTime(id, current, duration)
 * - onError(message, id)
 */
export default function ModelViewport({
  model,
  openIds = [],
  startTime = 0,
  playing,
  clipIndex,
  speed,
  wireframe,
  autoRotate,
  showGrid,
  showAxes,
  bg,
  seekRequest,
  resetSignal,
  onLoaded,
  onTime,
  onError,
}) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);
  const playingRef = useRef(playing);
  const clipRef = useRef(clipIndex);
  const speedRef = useRef(speed);
  const callbacksRef = useRef({ onLoaded, onTime, onError });
  const wireframeRef = useRef(wireframe);
  const startTimeRef = useRef(startTime);
  callbacksRef.current = { onLoaded, onTime, onError };
  wireframeRef.current = wireframe;
  startTimeRef.current = startTime;
  playingRef.current = playing;
  clipRef.current = clipIndex;
  speedRef.current = speed;

  // ── Scene setup (once) ──────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0e1a');

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
    camera.position.set(3, 2.2, 4.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 1.5;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 7, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x6c8bff, 0.5);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    // Both helpers are built at unit size and scaled to the model in
    // fitCamera(), so a 3-unit model doesn't sit in the middle of a 20-unit
    // floor. The grid sits a hair below y=0 so the axes' X/Z arms don't
    // z-fight it.
    const grid = new THREE.GridHelper(1, 20, 0x3ecf8e, 0x252b45);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.y = -0.004;
    scene.add(grid);
    const axes = new THREE.AxesHelper(1);
    axes.visible = false;
    scene.add(axes);

    const stage = new THREE.Group();
    scene.add(stage);

    const st = {
      renderer,
      scene,
      camera,
      controls,
      grid,
      axes,
      stage,
      mixer: null,
      clips: [],
      action: null,
      clipIndex: -1,
      duration: 0,
      /** Current clip time in seconds — the source of truth for the timeline. */
      time: 0,
      modelId: null,
      modelKey: null,
      /** Root currently parented to `stage`, or null. */
      attachedRoot: null,
      /** model id -> { root, clips } for instant switching between open models. */
      cache: new Map(),
      disposed: false,
    };
    stateRef.current = st;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let lastEmit = 0;
    let lastTime = -1;
    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      if (st.disposed) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      // Advance only while playing. Reading action.time (not mixer.time, which
      // is a monotonic global clock) keeps the timeline inside [0, duration].
      if (st.mixer && st.action && playingRef.current) {
        st.mixer.update(dt * speedRef.current);
        st.time = st.action.time;
      }
      controls.update();
      renderer.render(scene, camera);
      const now = performance.now();
      // Only report a frame when the time actually moved, so a paused player
      // stops re-rendering the page.
      if (st.duration > 0 && st.time !== lastTime && now - lastEmit > 60) {
        lastEmit = now;
        lastTime = st.time;
        callbacksRef.current.onTime?.(st.modelId, st.time, st.duration);
      }
    };
    loop();

    return () => {
      st.disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      clearStage(st);
      for (const entry of st.cache.values()) disposeObject(entry.root);
      st.cache.clear();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Apply display toggles ─────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.scene.background = new THREE.Color(bg);
    st.controls.autoRotate = autoRotate;
    st.grid.visible = showGrid;
    st.axes.visible = showAxes;
    applyWireframe(st.stage, wireframe);
  }, [bg, autoRotate, showGrid, showAxes, wireframe, model]);

  // ── Camera reset ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!resetSignal) return;
    const st = stateRef.current;
    if (!st) return;
    fitCamera(st);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // ── Release closed models ─────────────────────────────────────────────
  // Declared before the load effect so it runs first: a closed model's scene
  // is released before the promoted one is attached.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    pruneCache(st, openIds);
  }, [openIds]);

  // ── Load / swap model ─────────────────────────────────────────────────
  // Each opened model is parsed once and parked in st.cache; switching back
  // only re-attaches the cached root, so re-selecting is instant and the
  // playhead the page restored lands on the right frame.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;

    if (!model) {
      clearStage(st);
      st.modelKey = null;
      st.modelId = null;
      return;
    }
    if (st.modelKey === model.key) return;
    st.modelKey = model.key;
    st.modelId = model.id;

    const cached = st.cache.get(model.id);
    if (cached) {
      attachCached(
        st,
        cached,
        callbacksRef.current,
        clipRef.current,
        playingRef.current,
        wireframeRef.current,
        startTimeRef.current
      );
      return;
    }

    const loadId = model.id;
    let cancelled = false;
    clearStage(st);
    loadModelFile(model.url, model.ext)
      .then(({ group, clips }) => {
        if (cancelled || st.disposed) {
          disposeObject(group);
          return;
        }
        const root = normalizeModel(group);
        const entry = { root, clips, reported: false };
        st.cache.set(loadId, entry);
        attachCached(
          st,
          entry,
          callbacksRef.current,
          clipRef.current,
          playingRef.current,
          wireframeRef.current,
          startTimeRef.current
        );
      })
      .catch((e) =>
        callbacksRef.current.onError?.(e?.message || 'Không đọc được file model.', loadId)
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ── Playback: play/pause ──────────────────────────────────────────────
  // Only toggles the action's paused flag, so pausing keeps the current frame
  // instead of restarting the clip.
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.action) return;
    st.action.paused = !playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // ── Clip select ───────────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.mixer) return;
    if (st.clipIndex === clipIndex) return;
    playClip(st, clipIndex, playingRef.current);
    emitTime(st, callbacksRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIndex, model]);

  // ── Scrub ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.action || !seekRequest) return;
    // A request queued for the previous model must not move the new one.
    if (seekRequest.modelId && seekRequest.modelId !== st.modelId) return;
    const t = clampTime(seekRequest.time, st.duration);
    // Jump the action and re-evaluate the bindings without advancing the mixer:
    // update(0) leaves action.time alone and only pushes it into the skeleton.
    st.action.time = t;
    st.mixer.update(0);
    st.time = t;
    emitTime(st, callbacksRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  return (
    <div
      ref={mountRef}
      className="w-full h-full [&>canvas]:w-full [&>canvas]:h-full [&>canvas]:block [&>canvas]:rounded-lg"
    />
  );
}

/** Longest side of a loaded model, in world units, after normalization. */
const TARGET_SIZE = 3;

// ── Loading ─────────────────────────────────────────────────────────────

function loadModelFile(url, ext) {
  if (ext === 'glb' || ext === 'gltf') {
    return new GLTFLoader().loadAsync(url).then((gltf) => ({
      group: gltf.scene,
      clips: gltf.animations || [],
    }));
  }
  if (ext === 'obj') {
    return new OBJLoader().loadAsync(url).then((group) => ({ group, clips: [] }));
  }
  if (ext === 'stl') {
    return new STLLoader().loadAsync(url).then((geo) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x6c8bff,
        roughness: 0.5,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const group = new THREE.Group();
      group.add(mesh);
      return { group, clips: [] };
    });
  }
  if (ext === 'fbx') {
    return new FBXLoader().loadAsync(url).then((group) => ({
      group,
      clips: group.animations || [],
    }));
  }
  return Promise.reject(new Error(`Định dạng .${ext} chưa được hỗ trợ.`));
}

/**
 * Detach the current model and mount a cached (or freshly parsed) one.
 *
 * Stats/clips are reported only on the first attach: re-reporting them would
 * make the page reset the clip the user picked before switching away.
 */
function attachCached(st, entry, cbs, startClip, shouldPlay, wireframe, restoreTime) {
  const { root, clips } = entry;
  clearStage(st);
  st.stage.add(root);
  st.attachedRoot = root;
  st.clips = clips;
  st.duration = clips.length ? Math.max(...clips.map((c) => c.duration)) : 0;
  st.clipIndex = -1;

  if (!entry.reported) {
    entry.reported = true;
    const stats = { ...measureScene(root), animations: clips.length };
    cbs.onLoaded?.(
      st.modelId,
      stats,
      clips.map((c) => ({ name: c.name || 'clip', duration: c.duration }))
    );
  }

  applyWireframe(root, wireframe);
  // Animations must bind against the object we actually added to the scene.
  st.mixer = new THREE.AnimationMixer(root);
  if (clips.length) {
    playClip(st, Math.min(Math.max(startClip, 0), clips.length - 1), shouldPlay, restoreTime);
  } else {
    st.duration = 0;
    st.time = 0;
  }
  fitCamera(st);
  emitTime(st, cbs);
}

function measureScene(root) {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const geo = o.geometry;
    if (!geo) return;
    const pos = geo.getAttribute('position');
    if (pos) vertices += pos.count;
    if (geo.index) triangles += geo.index.count / 3;
    else if (pos) triangles += pos.count / 3;
  });
  return {
    meshes,
    vertices: Math.round(vertices),
    triangles: Math.round(triangles),
  };
}

/**
 * Dispose every cached scene whose model id is no longer in `keep`.
 *
 * The scene currently on screen can be one of them (the user closed the active
 * model and the page is promoting a neighbour). It is only marked, then
 * released by clearStage() — disposing it while it is still attached would let
 * a frame render freed buffers.
 */
function pruneCache(st, keep) {
  for (const [id, entry] of st.cache) {
    if (keep.includes(id)) continue;
    if (entry.root === st.attachedRoot) {
      entry.pendingDispose = true;
      continue;
    }
    disposeObject(entry.root);
    st.cache.delete(id);
  }
}

/**
 * Swap in the clip at `index`. `restoreTime` lets the page put a model back on
 * the frame it was paused at when the user switches away and back.
 */
function playClip(st, index, shouldPlay, restoreTime = 0) {
  if (st.action) {
    st.action.stop();
    st.action = null;
  }
  const clip = st.clips[index];
  st.clipIndex = index;
  if (!clip) {
    st.duration = 0;
    st.time = 0;
    return;
  }
  st.duration = clip.duration;
  st.time = clampTime(restoreTime, clip.duration);
  st.mixer.time = 0;
  st.action = st.mixer.clipAction(clip);
  st.action.reset();
  st.action.time = st.time;
  st.action.setLoop(THREE.LoopRepeat, Infinity);
  st.action.clampWhenFinished = false;
  st.action.play();
  st.action.paused = !shouldPlay;
  st.mixer.update(0);
}

function applyWireframe(root, wireframe) {
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if ('wireframe' in m) m.wireframe = wireframe;
      });
    }
  });
}

function clampTime(t, duration) {
  if (!isFinite(t)) return 0;
  const max = duration > 0 ? duration : 0;
  return Math.min(Math.max(t, 0), max);
}

function emitTime(st, cbs) {
  if (st.duration > 0) cbs.onTime?.(st.modelId, st.time, st.duration);
}

/**
 * Wraps the loaded object in a pivot whose own transform is identity, so the
 * fit transform below can be applied without clobbering a root transform the
 * loader (or an animation) already put on the model. Returns the pivot — the
 * object that must be added to the stage and passed to the mixer.
 */
function normalizeModel(group) {
  const pivot = new THREE.Group();
  pivot.add(group);
  pivot.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(pivot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = isFinite(maxDim) && maxDim > 0 ? TARGET_SIZE / maxDim : 1;

  // Scale and offset live on the same node, so the bounds map correctly:
  // X/Z centered on the origin, Y resting on the grid plane.
  pivot.scale.setScalar(scale);
  pivot.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  pivot.updateMatrixWorld(true);

  pivot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      if (!o.material || (Array.isArray(o.material) && !o.material.length)) {
        o.material = new THREE.MeshStandardMaterial({ color: 0x9fb4ff, roughness: 0.6 });
      }
    }
  });
  return pivot;
}

function fitCamera(st) {
  const camera = st.camera;
  const box = new THREE.Box3().setFromObject(st.stage);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.5);

  // Pull back far enough for the box to fit both the vertical and horizontal
  // FOV, so wide-and-short models are not cropped in a tall viewport.
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.15;

  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.8);
  camera.near = Math.max(dist / 1000, 0.001);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  st.controls.target.copy(center);
  st.controls.update();

  // Grid + axes live at the origin on the y=0 plane, which is where
  // normalizeModel put the model's footprint. Size them off the model so the
  // grid reads as a floor under it rather than a distant backdrop.
  const span = Math.max(size.x, size.z, 1) * 2;
  st.grid.scale.setScalar(span);
  st.grid.position.y = -0.004;
  st.axes.scale.setScalar(Math.max(span / 2, 0.5));
}

/**
 * Detach whatever model is on screen. The root itself is NOT disposed — it
 * stays owned by st.cache so the model can be switched back to. Scenes are
 * released by pruneCache() when their model is closed.
 */
function clearStage(st) {
  if (st.action) {
    st.action.stop();
    st.action = null;
  }
  if (st.mixer) {
    st.mixer.stopAllAction();
    st.mixer = null;
  }
  st.clips = [];
  st.duration = 0;
  st.time = 0;
  st.clipIndex = -1;
  while (st.stage.children.length) st.stage.remove(st.stage.children[0]);
  st.attachedRoot = null;

  // Scenes pruned while still on screen are safe to free now.
  for (const [id, entry] of st.cache) {
    if (entry.pendingDispose) {
      disposeObject(entry.root);
      st.cache.delete(id);
    }
  }
}

function disposeObject(obj) {
  obj.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) v.dispose?.();
        });
        m.dispose?.();
      });
    }
  });
}
