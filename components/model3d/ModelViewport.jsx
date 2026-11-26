'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { baseFileName, findResourceUrl, pickMaterialFile } from '@/lib/model3d';

const TEXTURE_SLOTS = [
  ['map', 'BaseColor'],
  ['normalMap', 'Normal'],
  ['roughnessMap', 'Roughness'],
  ['metalnessMap', 'Metalness'],
  ['aoMap', 'AO'],
  ['emissiveMap', 'Emissive'],
  ['alphaMap', 'Alpha'],
  ['bumpMap', 'Bump'],
  ['specularMap', 'Specular'],
  ['clearcoatMap', 'Clearcoat'],
  ['transmissionMap', 'Transmission'],
];

const _v = new THREE.Vector3();
const _vWorld = new THREE.Vector3();
const _instMat = new THREE.Matrix4();
const _worldMat = new THREE.Matrix4();

/**
 * Three.js canvas for the 3D Viewer page. Owns the renderer, camera, lights
 * and AnimationMixer; the page drives it through props and reads back
 * metadata via onLoaded / onTime.
 */
export default function ModelViewport({
  model,
  openIds = [],
  startTime = 0,
  playing,
  clipIndex,
  speed,
  wireframe,
  shading = 'lit',
  doubleSided = false,
  showBounds = false,
  showSkeleton = false,
  hiddenMeshes = [],
  autoRotate,
  showGrid,
  showAxes,
  bg,
  seekRequest,
  cameraView,
  resetSignal,
  snapFloorSignal,
  snapshotSignal,
  onFilesDrop,
  onLoaded,
  onTime,
  onSnapshot,
  onError,
}) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const playingRef = useRef(playing);
  const clipRef = useRef(clipIndex);
  const speedRef = useRef(speed);
  const callbacksRef = useRef({ onLoaded, onTime, onSnapshot, onError });
  const appearanceRef = useRef({ wireframe, shading, doubleSided, hiddenMeshes });
  const showBoundsRef = useRef(showBounds);
  const showSkeletonRef = useRef(showSkeleton);
  const startTimeRef = useRef(startTime);

  callbacksRef.current = { onLoaded, onTime, onSnapshot, onError };
  appearanceRef.current = { wireframe, shading, doubleSided, hiddenMeshes };
  showBoundsRef.current = showBounds;
  showSkeletonRef.current = showSkeleton;
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
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0e1a');

    // Procedural studio IBL so metallic PBR surfaces reflect cleanly instead of rendering black.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
    camera.position.set(3, 2.2, 4.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 1.5;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(4, 7, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x6c8bff, 0.4);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    // Built at unit size and scaled to the model in fitCamera(). Kept sub-millimeter
    // below y=0 (-0.0002) so flat mesh soles resting at y=0 don't z-fight the grid lines
    // while eliminating any visible floating gap.
    const grid = new THREE.GridHelper(1, 20, 0x3ecf8e, 0x252b45);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.position.set(0, -0.0002, 0);
    scene.add(grid);

    const axes = new THREE.AxesHelper(1);
    axes.visible = false;
    axes.renderOrder = 2;
    scene.add(axes);

    const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x6c8bff);
    boxHelper.visible = false;
    scene.add(boxHelper);

    const stage = new THREE.Group();
    scene.add(stage);

    const st = {
      renderer,
      scene,
      camera,
      controls,
      grid,
      axes,
      boxHelper,
      skeletonHelper: null,
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
      hiddenKey: '',
      /** Root currently parented to `stage`, or null. */
      attachedRoot: null,
      attachedEntry: null,
      /** model id -> { root, clips, rawMeta, formatInfo, totalVertices, clipAlign } */
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
    let lastBoundsSync = 0;
    let lastTime = -1;
    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      if (st.disposed) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const now = performance.now();
      if (st.mixer && st.action && playingRef.current) {
        st.mixer.update(dt * speedRef.current);
        st.time = st.action.time;
        if (st.boxHelper.visible && now - lastBoundsSync > 80) {
          lastBoundsSync = now;
          syncBoxHelper(st, true);
        }
      }
      controls.update();
      renderer.render(scene, camera);
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
      boxHelper.dispose?.();
      envTarget.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Apply display toggles & material overrides ────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    st.scene.background = new THREE.Color(bg);
    st.controls.autoRotate = autoRotate;
    st.grid.visible = showGrid;
    st.axes.visible = showAxes;
    if (st.skeletonHelper) st.skeletonHelper.visible = Boolean(showSkeleton);

    const nextHiddenKey = (hiddenMeshes || []).slice().sort().join('|');
    const hiddenChanged = st.hiddenKey !== nextHiddenKey;
    st.hiddenKey = nextHiddenKey;

    if (st.attachedRoot) {
      applyAppearance(st.attachedRoot, { wireframe, shading, doubleSided, hiddenMeshes });
      if (hiddenChanged && st.attachedEntry) {
        alignStageToFloor(st, st.attachedEntry, st.clipIndex);
      }
    }
    st.boxHelper.visible = Boolean(showBounds && st.attachedRoot);
    if (st.boxHelper.visible) syncBoxHelper(st, false);
  }, [
    bg,
    autoRotate,
    showGrid,
    showAxes,
    showBounds,
    showSkeleton,
    wireframe,
    shading,
    doubleSided,
    hiddenMeshes,
    model,
  ]);

  // ── Camera reset & view presets ───────────────────────────────────────
  useEffect(() => {
    if (!resetSignal) return;
    const st = stateRef.current;
    if (!st) return;
    fitCamera(st, 'iso');
  }, [resetSignal]);

  useEffect(() => {
    if (!cameraView?.nonce) return;
    const st = stateRef.current;
    if (!st) return;
    fitCamera(st, cameraView.preset || 'iso');
  }, [cameraView]);

  // ── Snap current pose flush onto floor (y=0) ──────────────────────────
  useEffect(() => {
    if (!snapFloorSignal) return;
    const st = stateRef.current;
    if (!st || !st.attachedRoot) return;
    st.stage.position.y = 0;
    st.stage.updateMatrixWorld(true);
    const box = computeVisualBounds(st.attachedRoot, { stride: 1 });
    if (!box.isEmpty()) {
      st.stage.position.y = -box.min.y;
      st.stage.updateMatrixWorld(true);
      if (st.skeletonHelper) st.skeletonHelper.matrixWorldNeedsUpdate = true;
      if (st.boxHelper.visible) syncBoxHelper(st, false);
    }
  }, [snapFloorSignal]);

  // ── Snapshot PNG ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!snapshotSignal) return;
    const st = stateRef.current;
    if (!st) return;
    st.renderer.render(st.scene, st.camera);
    st.renderer.domElement.toBlob((blob) => {
      if (blob) callbacksRef.current.onSnapshot?.(blob);
    }, 'image/png');
  }, [snapshotSignal]);

  // ── Release closed models ─────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    pruneCache(st, openIds);
  }, [openIds]);

  // ── Load / swap model ─────────────────────────────────────────────────
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
        appearanceRef.current,
        showBoundsRef.current,
        showSkeletonRef.current,
        startTimeRef.current
      );
      return;
    }

    const loadId = model.id;
    let cancelled = false;
    clearStage(st);
    loadModelFile(model.url, model.ext, model.resources, model.name)
      .then(({ group, clips, formatInfo }) => {
        if (cancelled || st.disposed) {
          disposeObject(group);
          return;
        }
        const { pivot, rawMeta, totalVertices } = normalizeModel(group);
        const entry = {
          root: pivot,
          clips,
          rawMeta,
          formatInfo: formatInfo || null,
          totalVertices,
          clipAlign: new Map(),
          reported: false,
        };
        st.cache.set(loadId, entry);
        attachCached(
          st,
          entry,
          callbacksRef.current,
          clipRef.current,
          playingRef.current,
          appearanceRef.current,
          showBoundsRef.current,
          showSkeletonRef.current,
          startTimeRef.current
        );
      })
      .catch((e) =>
        callbacksRef.current.onError?.(e?.message || 'Failed to read 3D model file.', loadId)
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ── Playback: play/pause ──────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.action) return;
    st.action.paused = !playing;
  }, [playing]);

  // ── Clip select ───────────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.mixer || !st.attachedEntry) return;
    if (st.clipIndex === clipIndex) return;
    playClip(st, clipIndex, playingRef.current, 0);
    alignStageToFloor(st, st.attachedEntry, st.clipIndex);
    emitTime(st, callbacksRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIndex, model]);

  // ── Scrub ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !st.action || !seekRequest) return;
    if (seekRequest.modelId && seekRequest.modelId !== st.modelId) return;
    const t = clampTime(seekRequest.time, st.duration);
    st.action.time = t;
    st.mixer.update(0);
    st.time = t;
    if (st.boxHelper.visible) syncBoxHelper(st, true);
    emitTime(st, callbacksRef.current);
  }, [seekRequest]);

  return (
    <div
      onDragOver={(e) => {
        if (!onFilesDrop) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!onFilesDrop) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) onFilesDrop(e.dataTransfer.files);
      }}
      className="relative w-full h-full"
    >
      <div
        ref={mountRef}
        className="w-full h-full [&>canvas]:w-full [&>canvas]:h-full [&>canvas]:block [&>canvas]:rounded-lg"
      />
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent/10 border border-dashed border-accent rounded-lg pointer-events-none text-[13px] font-medium text-text">
          Drop 3D model files to open
        </div>
      )}
      <button
        type="button"
        title="Fit the model inside the view"
        onClick={() => stateRef.current && fitCamera(stateRef.current, 'iso')}
        className="absolute bottom-2 right-2 bg-panel/80 border border-border text-muted hover:text-text px-2.5 py-1.5 rounded-lg text-[12px] backdrop-blur-sm"
      >
        ⤢ Fit
      </button>
    </div>
  );
}

/** Longest side of a loaded model, in world units, after normalization. */
const TARGET_SIZE = 3;

// ── Loading ─────────────────────────────────────────────────────────────

function loadModelFile(url, ext, resources, name) {
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(resourceManager(resources));
    loader.setMeshoptDecoder(MeshoptDecoder);
    return loader.loadAsync(url).then((gltf) => {
      const asset = gltf.parser?.json?.asset || null;
      return {
        group: gltf.scene,
        clips: gltf.animations || [],
        formatInfo: asset
          ? {
              version: asset.version || null,
              generator: asset.generator || null,
              copyright: asset.copyright || null,
            }
          : null,
      };
    });
  }
  if (ext === 'obj') {
    return loadObjWithMaterials(url, resources, name);
  }
  if (ext === 'stl') {
    return new STLLoader().loadAsync(url).then((geo) => {
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x6c8bff,
        roughness: 0.5,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = baseFileName(name).replace(/\.[^.]+$/, '') || 'STL Mesh';
      const group = new THREE.Group();
      group.add(mesh);
      return { group, clips: [], formatInfo: null };
    });
  }
  if (ext === 'fbx') {
    return new FBXLoader(resourceManager(resources)).loadAsync(url).then((group) => ({
      group,
      clips: group.animations || [],
      formatInfo: null,
    }));
  }
  return Promise.reject(new Error(`Unsupported format: .${ext}`));
}

function resourceManager(resources) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => findResourceUrl(resources, url) || url);
  return manager;
}

async function loadObjWithMaterials(url, resources, name) {
  const manager = resourceManager(resources);
  const mtlUrl = pickMaterialUrl(name || url, resources);

  let materials = null;
  if (mtlUrl) {
    const mtlLoader = new MTLLoader(manager);
    try {
      materials = await mtlLoader.loadAsync(mtlUrl);
      materials.preload();
    } catch {
      materials = null;
    }
  }

  const objLoader = new OBJLoader(manager);
  if (materials) objLoader.setMaterials(materials);
  const group = await objLoader.loadAsync(url);
  return { group, clips: [], formatInfo: null };
}

function pickMaterialUrl(nameOrUrl, resources) {
  const names = Object.keys(resources || {});
  const match = pickMaterialFile(nameOrUrl, names);
  return match ? findResourceUrl(resources, match) : null;
}

// ── Scene attachment & inspection ───────────────────────────────────────

function attachCached(
  st,
  entry,
  cbs,
  startClip,
  shouldPlay,
  appearance,
  showBounds,
  showSkeleton,
  restoreTime
) {
  const { root, clips } = entry;
  clearStage(st);
  st.stage.add(root);
  st.attachedRoot = root;
  st.attachedEntry = entry;
  st.clips = clips;
  st.duration = clips.length ? Math.max(...clips.map((c) => c.duration)) : 0;
  st.clipIndex = -1;

  if (!entry.reported) {
    entry.reported = true;
    const stats = inspectModel(root, entry.rawMeta, clips, entry.formatInfo);
    cbs.onLoaded?.(
      st.modelId,
      stats,
      clips.map((c, i) => ({
        name: c.name || `Clip ${i + 1}`,
        duration: c.duration,
        tracks: c.tracks?.length || 0,
      }))
    );
  }

  applyAppearance(root, appearance);

  if (hasBones(root)) {
    const helper = new THREE.SkeletonHelper(root);
    helper.visible = Boolean(showSkeleton);
    st.scene.add(helper);
    st.skeletonHelper = helper;
  }

  st.mixer = new THREE.AnimationMixer(root);
  if (clips.length) {
    const targetClip = Math.min(Math.max(startClip, 0), clips.length - 1);
    playClip(st, targetClip, shouldPlay, restoreTime);
    alignStageToFloor(st, entry, targetClip);
  } else {
    st.duration = 0;
    st.time = 0;
    alignStageToFloor(st, entry, -1);
  }

  st.boxHelper.visible = Boolean(showBounds);
  if (st.boxHelper.visible) syncBoxHelper(st, false);

  fitCamera(st, 'iso');
  emitTime(st, cbs);
}

function hasBones(root) {
  let found = false;
  root.traverse((o) => {
    if (o.isBone) found = true;
  });
  return found;
}

/**
 * Extract rich geometry, hierarchy, material, texture and animation specs for
 * the Inspector UI. Pure read over the parsed Three.js scene.
 */
function inspectModel(root, rawMeta, clips, formatInfo) {
  let meshes = 0;
  let skinnedMeshes = 0;
  let instancedMeshes = 0;
  let nodes = 0;
  let vertices = 0;
  let triangles = 0;
  let morphTargets = 0;

  const boneSet = new Set();
  const skeletonSet = new Set();
  const attributeSet = new Set();
  const materialMap = new Map();
  const textureMap = new Map();
  const meshList = [];

  root.traverse((o) => {
    if (o === root) return;
    nodes++;
    if (o.isBone) boneSet.add(o);
    if (!o.isMesh) return;

    meshes++;
    if (o.isSkinnedMesh) {
      skinnedMeshes++;
      if (o.skeleton) {
        skeletonSet.add(o.skeleton);
        for (const b of o.skeleton.bones || []) {
          if (b) boneSet.add(b);
        }
      }
    }
    if (o.isInstancedMesh) instancedMeshes++;

    const geo = o.geometry;
    const instances = o.isInstancedMesh ? Math.max(o.count || 1, 1) : 1;
    const counts = countGeometry(geo);
    const meshVerts = counts.vertices * instances;
    const meshTris = counts.triangles * instances;
    vertices += meshVerts;
    triangles += meshTris;

    const geoAttrs = geo?.attributes ? Object.keys(geo.attributes) : [];
    geoAttrs.forEach((a) => attributeSet.add(a));

    const morphCount = geo?.morphAttributes?.position?.length || 0;
    morphTargets += morphCount;

    const origMats = o.userData.__origMaterial
      ? Array.isArray(o.userData.__origMaterial)
        ? o.userData.__origMaterial
        : [o.userData.__origMaterial]
      : Array.isArray(o.material)
        ? o.material
        : o.material
          ? [o.material]
          : [];

    const matNames = [];
    for (const mat of origMats) {
      if (!mat) continue;
      const matName = mat.name || `Material ${materialMap.size + 1}`;
      matNames.push(matName);

      if (!materialMap.has(mat.uuid)) {
        const maps = [];
        for (const [prop, label] of TEXTURE_SLOTS) {
          const tex = mat[prop];
          if (tex && tex.isTexture) {
            maps.push(label);
            let texEntry = textureMap.get(tex.uuid);
            if (!texEntry) {
              const img = tex.image || tex.source?.data || null;
              texEntry = {
                name: tex.name || textureSourceName(tex) || `Texture ${textureMap.size + 1}`,
                width: img?.width || img?.videoWidth || 0,
                height: img?.height || img?.videoHeight || 0,
                colorSpace:
                  tex.colorSpace === THREE.SRGBColorSpace
                    ? 'sRGB'
                    : tex.colorSpace === THREE.LinearSRGBColorSpace
                      ? 'Linear'
                      : tex.colorSpace || 'Linear',
                slots: [],
              };
              textureMap.set(tex.uuid, texEntry);
            }
            if (!texEntry.slots.includes(label)) texEntry.slots.push(label);
          }
        }

        materialMap.set(mat.uuid, {
          name: matName,
          type: String(mat.type || 'Material').replace(/^Mesh|Material$/g, '') || 'Standard',
          color: mat.color?.isColor ? `#${mat.color.getHexString()}` : null,
          roughness: typeof mat.roughness === 'number' ? Number(mat.roughness.toFixed(2)) : null,
          metalness: typeof mat.metalness === 'number' ? Number(mat.metalness.toFixed(2)) : null,
          opacity: typeof mat.opacity === 'number' ? Number(mat.opacity.toFixed(2)) : 1,
          transparent: Boolean(mat.transparent),
          alphaTest: mat.alphaTest > 0 ? Number(mat.alphaTest.toFixed(2)) : 0,
          doubleSided: mat.side === THREE.DoubleSide,
          maps,
        });
      }
    }

    meshList.push({
      key: o.userData.__inspectorKey || `mesh-${meshList.length}`,
      name: o.name || o.parent?.name || `Mesh ${meshList.length + 1}`,
      type: o.isSkinnedMesh ? 'Skinned' : o.isInstancedMesh ? `Instanced ×${instances}` : 'Mesh',
      vertices: Math.round(meshVerts),
      triangles: Math.round(meshTris),
      materials: Array.from(new Set(matNames)),
      attributes: geoAttrs,
      morphTargets: morphCount,
    });
  });

  const clipList = (clips || []).map((c, i) => ({
    index: i,
    name: c.name || `Clip ${i + 1}`,
    duration: c.duration || 0,
    tracks: c.tracks?.length || 0,
    keyframes: (c.tracks || []).reduce((sum, t) => sum + (t.times?.length || 0), 0),
  }));

  return {
    meshes,
    skinnedMeshes,
    instancedMeshes,
    nodes,
    bones: boneSet.size,
    skeletons: skeletonSet.size,
    vertices: Math.round(vertices),
    triangles: Math.round(triangles),
    materials: materialMap.size,
    textures: textureMap.size,
    animations: clipList.length,
    morphTargets,
    attributes: Array.from(attributeSet),
    dimensions: rawMeta.dimensions,
    bounds: rawMeta.bounds,
    normalizedScale: rawMeta.scale,
    formatInfo,
    meshList,
    materialList: Array.from(materialMap.values()),
    textureList: Array.from(textureMap.values()),
    clipList,
  };
}

function textureSourceName(tex) {
  const src = tex.image?.currentSrc || tex.image?.src || tex.source?.data?.src || '';
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return '';
  return baseFileName(src);
}

/**
 * Counts referenced vertices and rendered triangles inside `geo.drawRange` so
 * glTF primitives sharing one large vertex buffer report accurate per-mesh counts.
 */
function countGeometry(geo) {
  if (!geo) return { vertices: 0, triangles: 0 };
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) return { vertices: 0, triangles: 0 };

  const rangeStart = Math.max(0, geo.drawRange?.start || 0);
  const rangeCount = geo.drawRange?.count ?? Infinity;

  if (geo.index) {
    const idx = geo.index;
    const end = Math.min(idx.count, rangeCount === Infinity ? idx.count : rangeStart + rangeCount);
    const seen = new Uint8Array(pos.count);
    let uniqueVerts = 0;
    for (let i = rangeStart; i < end; i++) {
      const v = idx.getX(i);
      if (v >= 0 && v < pos.count && !seen[v]) {
        seen[v] = 1;
        uniqueVerts++;
      }
    }
    return {
      vertices: uniqueVerts,
      triangles: Math.max(0, (end - rangeStart) / 3),
    };
  }

  const end = Math.min(pos.count, rangeCount === Infinity ? pos.count : rangeStart + rangeCount);
  const used = Math.max(0, end - rangeStart);
  return {
    vertices: used,
    triangles: used / 3,
  };
}

// ── Exact vertex bounds & ground alignment ──────────────────────────────

function isRenderableMaterial(mat) {
  if (!mat) return false;
  if (mat.visible === false) return false;
  if (mat.transparent && mat.opacity === 0) return false;
  return true;
}

function collectVisualTargets(root) {
  const primaryMeshes = [];
  const allMeshes = [];
  const fallback = [];

  const visit = (node) => {
    if (!node || node.visible === false || node.userData?.__hiddenByInspector) return;
    if (node.isMesh && node.geometry?.getAttribute('position')) {
      allMeshes.push(node);
      const orig = node.userData.__origMaterial ?? node.material;
      const mats = Array.isArray(orig) ? orig : orig ? [orig] : [];
      if (!mats.length || mats.some(isRenderableMaterial)) {
        primaryMeshes.push(node);
      }
    } else if ((node.isPoints || node.isLine) && node.geometry?.getAttribute('position')) {
      fallback.push(node);
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      visit(children[i]);
    }
  };

  visit(root);
  return {
    meshes: primaryMeshes.length ? primaryMeshes : allMeshes,
    fallback,
  };
}

/**
 * Exact world-space AABB computed from rendered vertex positions rather than
 * Three.js's conservative local-box transform (`Box3.setFromObject` with
 * `precise=false`). Fixes rotated meshes inflating AABB corners downward,
 * skips invisible/collider subtrees and unreferenced shared-buffer vertices,
 * and evaluates live SkinnedMesh / morph-target / InstancedMesh transforms.
 */
function computeVisualBounds(root, { stride = 1 } = {}) {
  const box = new THREE.Box3();
  if (!root) return box;

  root.updateMatrixWorld(true);
  const { meshes, fallback } = collectVisualTargets(root);
  const targets = meshes.length ? meshes : fallback;
  const step = Math.max(1, stride | 0);

  for (let t = 0; t < targets.length; t++) {
    const obj = targets[t];
    if (obj.isSkinnedMesh && obj.skeleton?.bones) {
      const bones = obj.skeleton.bones;
      for (let b = 0; b < bones.length; b++) {
        bones[b]?.updateWorldMatrix(true, false);
      }
    }

    const geo = obj.geometry;
    const pos = geo.getAttribute('position');
    if (!pos || pos.count === 0) continue;

    const rangeStart = Math.max(0, geo.drawRange?.start || 0);
    const rangeCount = geo.drawRange?.count ?? Infinity;

    if (geo.index) {
      const idx = geo.index;
      const end = Math.min(
        idx.count,
        rangeCount === Infinity ? idx.count : rangeStart + rangeCount
      );
      const seen = step === 1 ? new Uint8Array(pos.count) : null;
      for (let i = rangeStart; i < end; i += step) {
        const vIdx = idx.getX(i);
        if (vIdx < 0 || vIdx >= pos.count) continue;
        if (seen) {
          if (seen[vIdx]) continue;
          seen[vIdx] = 1;
        }
        expandByVertex(box, obj, pos, vIdx);
      }
    } else {
      const end = Math.min(
        pos.count,
        rangeCount === Infinity ? pos.count : rangeStart + rangeCount
      );
      for (let vIdx = rangeStart; vIdx < end; vIdx += step) {
        expandByVertex(box, obj, pos, vIdx);
      }
    }
  }

  return box;
}

function expandByVertex(box, obj, pos, vIdx) {
  if (obj.isMesh) {
    obj.getVertexPosition(vIdx, _v);
  } else {
    _v.fromBufferAttribute(pos, vIdx);
  }
  if (!isFinite(_v.x) || !isFinite(_v.y) || !isFinite(_v.z)) return;

  if (obj.isInstancedMesh && obj.count > 0) {
    for (let i = 0; i < obj.count; i++) {
      obj.getMatrixAt(i, _instMat);
      _worldMat.multiplyMatrices(obj.matrixWorld, _instMat);
      _vWorld.copy(_v).applyMatrix4(_worldMat);
      if (isFinite(_vWorld.x) && isFinite(_vWorld.y) && isFinite(_vWorld.z)) {
        box.expandByPoint(_vWorld);
      }
    }
    return;
  }

  _v.applyMatrix4(obj.matrixWorld);
  if (isFinite(_v.x) && isFinite(_v.y) && isFinite(_v.z)) {
    box.expandByPoint(_v);
  }
}

/**
 * Wraps the loaded object in a clean pivot, records its unscaled dimensions and
 * places its exact visible base at y=0.
 */
function normalizeModel(group) {
  const pivot = new THREE.Group();
  pivot.add(group);

  let meshIndex = 0;
  let totalVertices = 0;
  pivot.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    if (!o.material || (Array.isArray(o.material) && !o.material.length)) {
      o.material = new THREE.MeshStandardMaterial({ color: 0x9fb4ff, roughness: 0.6 });
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (m && m.userData.__origSide === undefined) {
        m.userData.__origSide = m.side;
      }
    });
    o.userData.__origMaterial = o.material;
    o.userData.__origVisible = o.visible !== false;
    o.userData.__inspectorKey = `mesh-${meshIndex++}`;
    totalVertices += o.geometry?.getAttribute('position')?.count || 0;
  });

  const rawBox = computeVisualBounds(pivot, { stride: 1 });
  const rawSize = rawBox.isEmpty()
    ? new THREE.Vector3(1, 1, 1)
    : rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.isEmpty()
    ? new THREE.Vector3(0, 0, 0)
    : rawBox.getCenter(new THREE.Vector3());
  const rawMin = rawBox.isEmpty() ? new THREE.Vector3(0, 0, 0) : rawBox.min.clone();
  const rawMax = rawBox.isEmpty() ? new THREE.Vector3(0, 0, 0) : rawBox.max.clone();

  const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
  const scale = isFinite(maxDim) && maxDim > 0 ? TARGET_SIZE / maxDim : 1;

  pivot.scale.setScalar(scale);
  pivot.position.set(-rawCenter.x * scale, -rawMin.y * scale, -rawCenter.z * scale);
  pivot.updateMatrixWorld(true);

  // Verify world-space min.y in case a detached SkinnedMesh had a separate bind transform.
  const verifyBox = computeVisualBounds(pivot, { stride: 1 });
  if (!verifyBox.isEmpty() && Math.abs(verifyBox.min.y) > 1e-5) {
    pivot.position.y -= verifyBox.min.y;
    pivot.updateMatrixWorld(true);
  }

  return {
    pivot,
    totalVertices,
    rawMeta: {
      scale,
      dimensions: { x: rawSize.x, y: rawSize.y, z: rawSize.z },
      bounds: {
        min: { x: rawMin.x, y: rawMin.y, z: rawMin.z },
        max: { x: rawMax.x, y: rawMax.y, z: rawMax.z },
        center: { x: rawCenter.x, y: rawCenter.y, z: rawCenter.z },
      },
    },
  };
}

/**
 * Aligns `st.stage` so the lowest point of the model (in its static pose or
 * across the active animation clip's contact pose) sits flush on y=0.
 *
 * Rigged models often have a bind pose whose tail/cape/root sits lower or
 * higher than every animation clip; sampling the active clip ensures the
 * animated model sits right on the floor plane while jumps still rise off it.
 */
function alignStageToFloor(st, entry, clipIndex) {
  st.stage.position.set(0, 0, 0);
  st.stage.updateMatrixWorld(true);

  const cacheKey = `${clipIndex}:${st.hiddenKey || ''}`;
  let align = entry.clipAlign.get(cacheKey);

  if (!align) {
    if (!st.clips.length || clipIndex < 0 || !st.mixer || !st.action) {
      const box = computeVisualBounds(entry.root, { stride: 1 });
      align = {
        x: 0,
        y: box.isEmpty() ? 0 : -box.min.y,
        z: 0,
      };
    } else {
      const savedTime = st.action.time;
      const savedPaused = st.action.paused;
      st.action.paused = false;

      st.action.time = 0;
      st.mixer.update(0);
      const box0 = computeVisualBounds(entry.root, { stride: 1 });

      let bestT = 0;
      let lowestSampleY = box0.isEmpty() ? Infinity : box0.min.y;
      const duration = st.duration || 0;
      if (duration > 0) {
        const stride = Math.max(1, Math.ceil((entry.totalVertices || 1) / 3000));
        const samples = 12;
        for (let s = 1; s <= samples; s++) {
          const t = (s / samples) * duration;
          st.action.time = t;
          st.mixer.update(0);
          const sampleBox = computeVisualBounds(entry.root, { stride });
          if (!sampleBox.isEmpty() && sampleBox.min.y < lowestSampleY) {
            lowestSampleY = sampleBox.min.y;
            bestT = t;
          }
        }
      }

      let floorY = box0.isEmpty() ? 0 : box0.min.y;
      if (bestT > 0) {
        st.action.time = bestT;
        st.mixer.update(0);
        const boxBest = computeVisualBounds(entry.root, { stride: 1 });
        if (!boxBest.isEmpty()) {
          floorY = Math.min(floorY, boxBest.min.y);
        }
      }

      let offsetX = 0;
      let offsetZ = 0;
      if (!box0.isEmpty()) {
        const c0 = box0.getCenter(new THREE.Vector3());
        if (Math.hypot(c0.x, c0.z) > 0.35) {
          offsetX = -c0.x;
          offsetZ = -c0.z;
        }
      }

      st.action.time = savedTime;
      st.mixer.update(0);
      st.action.paused = savedPaused;

      align = {
        x: isFinite(offsetX) ? offsetX : 0,
        y: isFinite(floorY) ? -floorY : 0,
        z: isFinite(offsetZ) ? offsetZ : 0,
      };
    }
    entry.clipAlign.set(cacheKey, align);
  }

  st.stage.position.set(align.x, align.y, align.z);
  st.stage.updateMatrixWorld(true);
  if (st.skeletonHelper) st.skeletonHelper.matrixWorldNeedsUpdate = true;
  if (st.boxHelper.visible) syncBoxHelper(st, false);
}

function syncBoxHelper(st, fast) {
  if (!st.attachedRoot) return;
  const stride = fast ? Math.max(1, Math.ceil((st.attachedEntry?.totalVertices || 1) / 2500)) : 1;
  const box = computeVisualBounds(st.stage, { stride });
  if (!box.isEmpty()) {
    st.boxHelper.box.copy(box);
  }
}

// ── Playback, materials, camera & cleanup ───────────────────────────────

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

function applyAppearance(
  root,
  { wireframe, shading = 'lit', doubleSided = false, hiddenMeshes = [] }
) {
  const hiddenSet = new Set(hiddenMeshes);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.userData.__inspectorKey;
    const hidden = key ? hiddenSet.has(key) : false;
    o.userData.__hiddenByInspector = hidden;
    o.visible = Boolean(o.userData.__origVisible ?? true) && !hidden;

    const orig = o.userData.__origMaterial ?? o.material;
    if (!orig) return;

    let activeMat = orig;
    if (shading === 'unlit') {
      if (!o.userData.__unlitMaterial) {
        o.userData.__unlitMaterial = mapMaterialSet(orig, (m) => {
          const basic = new THREE.MeshBasicMaterial({
            color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
            map: m.map || null,
            alphaMap: m.alphaMap || null,
            transparent: Boolean(m.transparent),
            opacity: m.opacity ?? 1,
            alphaTest: m.alphaTest ?? 0,
            vertexColors: Boolean(m.vertexColors),
          });
          basic.userData.__origSide = m.userData?.__origSide ?? m.side;
          return basic;
        });
      }
      activeMat = o.userData.__unlitMaterial;
    } else if (shading === 'normals') {
      if (!o.userData.__normalMaterial) {
        o.userData.__normalMaterial = mapMaterialSet(orig, (m) => {
          const norm = new THREE.MeshNormalMaterial({
            flatShading: Boolean(m.flatShading),
          });
          norm.userData.__origSide = m.userData?.__origSide ?? m.side;
          return norm;
        });
      }
      activeMat = o.userData.__normalMaterial;
    }

    o.material = activeMat;
    const mats = Array.isArray(activeMat) ? activeMat : [activeMat];
    mats.forEach((m) => {
      if (!m) return;
      if ('wireframe' in m) m.wireframe = Boolean(wireframe);
      const targetSide = doubleSided
        ? THREE.DoubleSide
        : (m.userData?.__origSide ?? THREE.FrontSide);
      if (m.side !== targetSide) {
        m.side = targetSide;
        m.needsUpdate = true;
      }
    });
  });
}

function mapMaterialSet(orig, fn) {
  return Array.isArray(orig) ? orig.map((m) => (m ? fn(m) : m)) : fn(orig);
}

function clampTime(t, duration) {
  if (!isFinite(t)) return 0;
  const max = duration > 0 ? duration : 0;
  return Math.min(Math.max(t, 0), max);
}

function emitTime(st, cbs) {
  if (st.duration > 0) cbs.onTime?.(st.modelId, st.time, st.duration);
}

function fitCamera(st, preset = 'iso') {
  const camera = st.camera;
  const stride = Math.max(1, Math.ceil((st.attachedEntry?.totalVertices || 1) / 4000));
  let box = computeVisualBounds(st.stage, { stride });
  if (box.isEmpty()) box = new THREE.Box3().setFromObject(st.stage);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.5);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.15;

  if (preset === 'front') {
    camera.position.set(center.x, center.y, center.z + dist);
  } else if (preset === 'right') {
    camera.position.set(center.x + dist, center.y, center.z);
  } else if (preset === 'top') {
    camera.position.set(center.x, center.y + dist, center.z + 0.001);
  } else {
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.8);
  }

  camera.near = Math.max(dist / 500, 0.002);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  st.controls.target.copy(center);
  st.controls.update();

  const span = Math.max(size.x, size.z, 1) * 2;
  st.grid.scale.setScalar(span);
  st.grid.position.set(0, -0.0002, 0);
  st.axes.scale.setScalar(Math.max(span / 2, 0.5));
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
  if (st.skeletonHelper) {
    st.scene.remove(st.skeletonHelper);
    st.skeletonHelper.dispose?.();
    st.skeletonHelper = null;
  }
  st.boxHelper.visible = false;
  st.clips = [];
  st.duration = 0;
  st.time = 0;
  st.clipIndex = -1;
  st.stage.position.set(0, 0, 0);
  while (st.stage.children.length) st.stage.remove(st.stage.children[0]);
  st.attachedRoot = null;
  st.attachedEntry = null;

  for (const [id, entry] of st.cache) {
    if (entry.pendingDispose) {
      disposeObject(entry.root);
      st.cache.delete(id);
    }
  }
}

function disposeMaterialSet(matOrArray, disposeTextures) {
  if (!matOrArray) return;
  const mats = Array.isArray(matOrArray) ? matOrArray : [matOrArray];
  mats.forEach((m) => {
    if (!m) return;
    if (disposeTextures) {
      Object.values(m).forEach((v) => {
        if (v && v.isTexture) v.dispose?.();
      });
    }
    m.dispose?.();
  });
}

function disposeObject(obj) {
  obj.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose?.();
    const orig = o.userData?.__origMaterial ?? o.material;
    disposeMaterialSet(orig, true);
    disposeMaterialSet(o.userData?.__unlitMaterial, false);
    disposeMaterialSet(o.userData?.__normalMaterial, false);
  });
}
