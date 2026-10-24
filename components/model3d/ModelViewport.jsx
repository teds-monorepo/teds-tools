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
 * - model: { url, ext, name, key } | null
 * - playing, clipIndex, speed, wireframe, autoRotate, showGrid, showAxes, bg
 * - seekRequest: { time, nonce } | null — jump the mixer to `time`
 * - resetSignal: number — change to refit + reset the camera
 */
export default function ModelViewport({
  model,
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
  callbacksRef.current = { onLoaded, onTime, onError };
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

    const grid = new THREE.GridHelper(20, 20, 0x3ecf8e, 0x252b45);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    scene.add(grid);
    const axes = new THREE.AxesHelper(2);
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
      duration: 0,
      modelKey: null,
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
    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      if (st.disposed) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (st.mixer) st.mixer.update(dt * speedRef.current);
      controls.update();
      renderer.render(scene, camera);
      const now = performance.now();
      if (st.mixer && st.duration > 0 && now - lastEmit > 120) {
        lastEmit = now;
        callbacksRef.current.onTime?.(st.mixer.time, st.duration);
      }
    };
    loop();

    return () => {
      st.disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeObject(stage);
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
    st.stage.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if ('wireframe' in m) m.wireframe = wireframe;
        });
      }
    });
  }, [bg, autoRotate, showGrid, showAxes, wireframe, model]);

  // ── Camera reset ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!resetSignal) return;
    const st = stateRef.current;
    if (!st) return;
    fitCamera(st);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // ── Load / swap model ─────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    if (!model || st.modelKey === model.key) return;
    st.modelKey = model.key;

    clearStage(st);
    let cancelled = false;
    loadModelFile(model.url, model.ext)
      .then(({ group, clips }) => {
        if (cancelled) {
          disposeObject(group);
          return;
        }
        finishLoad(st, group, clips, callbacksRef.current, clipRef.current, playingRef.current);
      })
      .catch((e) => callbacksRef.current.onError?.(e?.message || 'Không đọc được file model.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ── Playback: play/pause + clip select ────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.mixer) return;
    playClip(st, clipIndex, playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clipIndex, model]);

  // ── Scrub ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.mixer || !seekRequest) return;
    st.mixer.setTime(Math.min(Math.max(seekRequest.time, 0), st.duration || 0));
    callbacksRef.current.onTime?.(st.mixer.time, st.duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  return <div ref={mountRef} className="w-full h-full [&>canvas]:w-full [&>canvas]:h-full [&>canvas]:block [&>canvas]:rounded-lg" />;
}

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
      const mat = new THREE.MeshStandardMaterial({ color: 0x6c8bff, roughness: 0.5, metalness: 0.1 });
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

function finishLoad(st, group, clips, cbs, startClip = 0, shouldPlay = true) {
  clearStage(st);
  normalizeModel(group);
  st.stage.add(group);
  st.clips = clips;
  st.duration = clips.length ? Math.max(...clips.map((c) => c.duration)) : 0;

  // Report scene stats + available animation clips to the page.
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  group.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const geo = o.geometry;
      if (geo) {
        const pos = geo.getAttribute('position');
        if (pos) vertices += pos.count;
        if (geo.index) triangles += geo.index.count / 3;
        else if (pos) triangles += pos.count / 3;
      }
    }
  });
  cbs.onLoaded?.(
    {
      meshes,
      vertices: Math.round(vertices),
      triangles: Math.round(triangles),
      animations: clips.length,
    },
    clips.map((c) => ({ name: c.name || 'clip', duration: c.duration }))
  );

  st.mixer = new THREE.AnimationMixer(group);
  playClip(st, Math.min(Math.max(startClip, 0), Math.max(clips.length - 1, 0)), shouldPlay);
  fitCamera(st);
}

function playClip(st, index, shouldPlay) {
  if (st.action) {
    st.action.stop();
    st.action = null;
  }
  const clip = st.clips[index];
  if (!clip) {
    st.duration = 0;
    return;
  }
  st.duration = clip.duration;
  st.action = st.mixer.clipAction(clip);
  st.action.setLoop(THREE.LoopRepeat, Infinity);
  st.action.clampWhenFinished = false;
  if (shouldPlay) st.action.play();
  else {
    st.action.play();
    st.action.paused = true;
  }
}

/** Center + scale the model so small mm-models and huge scenes both fit. */
function normalizeModel(group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  group.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 3 / maxDim;
  if (scale !== 1 && isFinite(scale)) group.scale.setScalar(scale);
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      if (!o.material || (Array.isArray(o.material) && !o.material.length)) {
        o.material = new THREE.MeshStandardMaterial({ color: 0x9fb4ff, roughness: 0.6 });
      }
    }
  });
}

function fitCamera(st) {
  const box = new THREE.Box3().setFromObject(st.stage);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.5);
  const dist = radius * 2.4;
  st.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.8);
  st.camera.near = Math.max(dist / 1000, 0.001);
  st.camera.far = dist * 100;
  st.camera.updateProjectionMatrix();
  st.controls.target.copy(center);
  st.controls.update();
}

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
  while (st.stage.children.length) {
    const child = st.stage.children[0];
    st.stage.remove(child);
    disposeObject(child);
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
