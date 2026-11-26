'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, SubItem, ContentPane } from '@/components/Sidebar';
import { DropZone, Section, Toast, useToast } from '@/components/assets/Shared';
import ModelViewport from '@/components/model3d/ModelViewport';
import {
  ACCEPT_ATTR,
  baseFileName,
  detectFormat,
  describeStats,
  formatAttributeName,
  formatBytes,
  formatCoord,
  formatDimensions,
  formatNumber,
  formatScale,
  formatTime,
  formatVec3,
  isCompanionFile,
} from '@/lib/model3d';
import { downloadBlob } from '@/lib/zip';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const SHADING_MODES = [
  { id: 'lit', label: 'Lit' },
  { id: 'unlit', label: 'Unlit' },
  { id: 'normals', label: 'Normals' },
];
const CAMERA_PRESETS = [
  { id: 'front', label: 'Front' },
  { id: 'right', label: 'Side' },
  { id: 'top', label: 'Top' },
  { id: 'iso', label: 'Reset camera' },
];
const BG_CHOICES = [
  { id: '#0b0e1a', label: 'Dark' },
  { id: '#1a1f33', label: 'Panel' },
  { id: '#e8eaf3', label: 'Light' },
  { id: '#000000', label: 'Black' },
];

const ghostBtnClass =
  'bg-transparent border border-border text-muted hover:text-text px-2.5 py-1.5 rounded-lg text-[12.5px]';
const toggleClass = (on) =>
  `px-2.5 py-1.5 rounded-lg text-[12.5px] border ${
    on ? 'bg-accent/[0.14] border-accent/40 text-text' : ghostBtnClass
  }`;

export default function Model3dPage() {
  const { toast, show } = useToast();
  const [models, setModels] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [speed, setSpeed] = useState(1);
  const [playhead, setPlayhead] = useState({ current: 0, duration: 0 });
  const [seekRequest, setSeekRequest] = useState(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [snapFloorSignal, setSnapFloorSignal] = useState(0);
  const [cameraView, setCameraView] = useState(null);
  const [snapshotSignal, setSnapshotSignal] = useState(0);

  const [wireframe, setWireframe] = useState(false);
  const [shading, setShading] = useState('lit');
  const [doubleSided, setDoubleSided] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(false);
  const [bg, setBg] = useState(BG_CHOICES[0].id);
  const [inspectorTab, setInspectorTab] = useState('meshes');

  const fileInputRef = useRef(null);
  const playheadsRef = useRef({});
  const resourcesRef = useRef({});

  const active = models.find((m) => m.id === activeId) || null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const clipIndex = active?.clipIndex ?? 0;
  const clips = active?.clips ?? [];
  const playing = active?.playing ?? false;
  const hiddenMeshes = active?.hiddenMeshes ?? [];
  const stats = active?.stats ?? null;
  const duration = playhead.duration || clips[clipIndex]?.duration || 0;
  const openIds = useMemo(() => models.map((m) => m.id), [models]);

  const modelsRef = useRef(models);
  modelsRef.current = models;
  useEffect(
    () => () => {
      modelsRef.current.forEach((m) => URL.revokeObjectURL(m.url));
      for (const url of Object.values(resourcesRef.current)) URL.revokeObjectURL(url);
    },
    []
  );

  const patchModel = useCallback((id, patch) => {
    modelsRef.current = modelsRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setModels(modelsRef.current);
  }, []);

  const openFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;

      let companionCount = 0;
      for (const file of files) {
        if (!isCompanionFile(file.name)) continue;
        const key = baseFileName(file.name);
        const previous = resourcesRef.current[key];
        if (previous) URL.revokeObjectURL(previous);
        resourcesRef.current[key] = URL.createObjectURL(file);
        companionCount++;
      }

      const added = [];
      for (const file of files) {
        if (isCompanionFile(file.name)) continue;
        const ext = detectFormat(file.name);
        if (!ext) {
          show(
            `Unsupported file: ${file.name} (.glb/.gltf/.obj/.stl/.fbx, plus .mtl + textures for .obj)`,
            'error'
          );
          continue;
        }
        const id = `${file.name}-${file.size}-${Date.now()}-${added.length}`;
        added.push({
          id,
          key: id,
          url: URL.createObjectURL(file),
          ext,
          name: file.name,
          size: file.size,
          resources: resourcesRef.current,
          stats: null,
          clips: [],
          clipIndex: 0,
          playing: true,
          hiddenMeshes: [],
        });
      }

      if (!added.length) {
        if (companionCount) {
          show('Materials/textures added — drop the .obj or .gltf they belong to.');
        }
        return;
      }
      modelsRef.current = [...modelsRef.current, ...added];
      setModels(modelsRef.current);
      setActiveId(added[0].id);
      setSeekRequest(null);
      setPlayhead({ current: 0, duration: 0 });
    },
    [show]
  );

  const removeModel = useCallback((id) => {
    const current = modelsRef.current;
    const removed = current.find((m) => m.id === id);
    if (!removed) return;
    URL.revokeObjectURL(removed.url);
    delete playheadsRef.current[id];
    const next = current.filter((m) => m.id !== id);
    modelsRef.current = next;
    setModels(next);

    if (activeIdRef.current === id) {
      const promoted = next[0] ?? null;
      setActiveId(promoted?.id ?? null);
      setSeekRequest(null);
      setPlayhead({
        current: promoted ? (playheadsRef.current[promoted.id] ?? 0) : 0,
        duration: promoted?.clips[promoted.clipIndex]?.duration || 0,
      });
    }
  }, []);

  const closeAll = useCallback(() => {
    modelsRef.current.forEach((m) => URL.revokeObjectURL(m.url));
    for (const url of Object.values(resourcesRef.current)) URL.revokeObjectURL(url);
    resourcesRef.current = {};
    modelsRef.current = [];
    setModels([]);
    playheadsRef.current = {};
    setActiveId(null);
    setSeekRequest(null);
    setPlayhead({ current: 0, duration: 0 });
  }, []);

  const selectModel = useCallback((id) => {
    if (id === activeIdRef.current) return;
    const target = modelsRef.current.find((m) => m.id === id);
    if (!target) return;
    setSeekRequest(null);
    setActiveId(id);
    setPlayhead({
      current: playheadsRef.current[id] ?? 0,
      duration: target.clips[target.clipIndex]?.duration || 0,
    });
  }, []);

  const handleLoaded = useCallback(
    (id, nextStats, nextClips) => {
      patchModel(id, { stats: nextStats, clips: nextClips, clipIndex: 0 });
      if (activeIdRef.current !== id) return;
      setPlayhead({
        current: playheadsRef.current[id] ?? 0,
        duration: nextClips[0]?.duration || 0,
      });
    },
    [patchModel]
  );

  const handleTime = useCallback((id, current, durationValue) => {
    playheadsRef.current[id] = current;
    if (id !== activeIdRef.current) return;
    setPlayhead((prev) =>
      prev.current === current && prev.duration === durationValue
        ? prev
        : { current, duration: durationValue }
    );
  }, []);

  const handleError = useCallback(
    (msg, id) => {
      show(msg, 'error');
      if (id) removeModel(id);
    },
    [show, removeModel]
  );

  const changeClip = useCallback(
    (index) => {
      if (!active) return;
      patchModel(active.id, { clipIndex: index });
      playheadsRef.current[active.id] = 0;
      setPlayhead({ current: 0, duration: clips[index]?.duration || 0 });
    },
    [active, clips, patchModel]
  );

  const seek = useCallback(
    (value) => {
      if (!active) return;
      playheadsRef.current[active.id] = value;
      setPlayhead((prev) => ({ ...prev, current: value }));
      setSeekRequest({ modelId: active.id, time: value, nonce: Date.now() });
    },
    [active]
  );

  const toggleMeshVisibility = useCallback(
    (meshKey) => {
      if (!active) return;
      const current = active.hiddenMeshes || [];
      const next = current.includes(meshKey)
        ? current.filter((k) => k !== meshKey)
        : [...current, meshKey];
      patchModel(active.id, { hiddenMeshes: next });
    },
    [active, patchModel]
  );

  const copySpecsJson = useCallback(() => {
    if (!active || !stats) return;
    const payload = {
      name: active.name,
      format: active.ext.toUpperCase(),
      fileSize: active.size,
      fileSizeFormatted: formatBytes(active.size),
      ...stats,
    };
    navigator.clipboard
      ?.writeText(JSON.stringify(payload, null, 2))
      .then(() => show('Copied model specs JSON'))
      .catch(() => show('Could not copy to clipboard', 'error'));
  }, [active, stats, show]);

  const handleOpenModelMenuClick = useCallback(() => {
    if (activeIdRef.current === null) {
      fileInputRef.current?.click();
      return;
    }
    setSeekRequest(null);
    setActiveId(null);
    setPlayhead({ current: 0, duration: 0 });
  }, []);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) openFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <Sidebar
        title="3D Viewer"
        activeLabel={active ? active.name : 'Open model'}
        action={
          models.length ? (
            <button
              type="button"
              onClick={closeAll}
              title="Close all models"
              className={ghostBtnClass}
            >
              ✕
            </button>
          ) : null
        }
      >
        <SubItem
          active={activeId === null}
          onClick={handleOpenModelMenuClick}
          onFilesDrop={openFiles}
          dropSub="Drop files to open model"
          label="Open model"
          sub="Click or drop files · .glb .gltf .obj .stl .fbx"
          icon={<Badge>◈</Badge>}
        />

        {models.map((m) => (
          <div key={m.id} className="flex items-stretch gap-1 group">
            <div className="flex-1 min-w-0">
              <SubItem
                active={m.id === activeId}
                onClick={() => selectModel(m.id)}
                label={m.name}
                sub={
                  [formatBytes(m.size), describeStats(m.stats)].filter(Boolean).join(' · ') ||
                  'Loading…'
                }
                icon={<Badge>{m.ext.toUpperCase().slice(0, 3)}</Badge>}
              />
            </div>
            <button
              type="button"
              onClick={() => removeModel(m.id)}
              title={`Close ${m.name}`}
              className="flex-shrink-0 w-6 self-center text-muted hover:text-text opacity-0 group-hover:opacity-100 focus:opacity-100 rounded"
            >
              ✕
            </button>
          </div>
        ))}
      </Sidebar>

      <ContentPane>
        <div className="bg-panel border border-border rounded-card px-4.5 pt-4.5 pb-4.5 flex flex-col gap-3.5">
          {!active ? (
            <DropZone onFiles={openFiles} accept={ACCEPT_ATTR} icon="◈" multiple>
              <div className="text-[13.5px] font-medium">Drop a 3D model here</div>
              <div className="text-[12px] text-muted">
                .glb .gltf .obj .stl .fbx — drop several to keep them side by side
              </div>
              <div className="text-[11.5px] text-muted">
                For .obj, drop the .mtl and its textures with it · you can also drop onto Open model
                in the sidebar
              </div>
            </DropZone>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium truncate" title={active.name}>
                    {active.name}
                  </div>
                  <div className="text-[11.5px] text-muted">
                    {[
                      active.ext.toUpperCase(),
                      formatBytes(active.size),
                      describeStats(active.stats),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className={ghostBtnClass}
                  >
                    + Add model
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnapshotSignal((n) => n + 1)}
                    className={ghostBtnClass}
                  >
                    Snapshot PNG
                  </button>
                  <button
                    type="button"
                    onClick={() => removeModel(active.id)}
                    className={ghostBtnClass}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="h-[460px] min-h-[320px] bg-bg border border-border rounded-lg overflow-hidden">
                <ModelViewport
                  model={active}
                  openIds={openIds}
                  startTime={playheadsRef.current[active.id] ?? 0}
                  playing={playing}
                  clipIndex={clipIndex}
                  speed={speed}
                  wireframe={wireframe}
                  shading={shading}
                  doubleSided={doubleSided}
                  showBounds={showBounds}
                  showSkeleton={showSkeleton}
                  hiddenMeshes={hiddenMeshes}
                  autoRotate={autoRotate}
                  showGrid={showGrid}
                  showAxes={showAxes}
                  bg={bg}
                  seekRequest={seekRequest}
                  cameraView={cameraView}
                  resetSignal={resetSignal}
                  snapFloorSignal={snapFloorSignal}
                  snapshotSignal={snapshotSignal}
                  onFilesDrop={openFiles}
                  onLoaded={handleLoaded}
                  onTime={handleTime}
                  onSnapshot={(blob) =>
                    downloadBlob(blob, `${active.name.replace(/\.[^.]+$/, '')}.png`)
                  }
                  onError={handleError}
                />
              </div>

              <Section
                title="View"
                actions={
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSnapFloorSignal((n) => n + 1)}
                      title="Align the current pose flush onto the bottom grid plane"
                      className={ghostBtnClass}
                    >
                      Snap to floor
                    </button>
                    {CAMERA_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          p.id === 'iso'
                            ? setResetSignal((n) => n + 1)
                            : setCameraView({ preset: p.id, nonce: Date.now() })
                        }
                        className={ghostBtnClass}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 mr-1">
                    {SHADING_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setShading(m.id)}
                        className={toggleClass(shading === m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setWireframe((v) => !v)}
                    className={toggleClass(wireframe)}
                  >
                    Wireframe
                  </button>
                  <button
                    type="button"
                    onClick={() => setDoubleSided((v) => !v)}
                    className={toggleClass(doubleSided)}
                  >
                    Double-sided
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBounds((v) => !v)}
                    className={toggleClass(showBounds)}
                  >
                    Bounds
                  </button>
                  {stats?.bones > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowSkeleton((v) => !v)}
                      className={toggleClass(showSkeleton)}
                    >
                      Skeleton
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAutoRotate((v) => !v)}
                    className={toggleClass(autoRotate)}
                  >
                    Auto-rotate
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowGrid((v) => !v)}
                    className={toggleClass(showGrid)}
                  >
                    Grid
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAxes((v) => !v)}
                    className={toggleClass(showAxes)}
                  >
                    Axes
                  </button>
                  <div className="flex items-center gap-1 ml-1">
                    {BG_CHOICES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        title={c.label}
                        onClick={() => setBg(c.id)}
                        className={`w-6 h-6 rounded-md border ${
                          bg === c.id ? 'border-accent' : 'border-border'
                        }`}
                        style={{ backgroundColor: c.id }}
                      />
                    ))}
                  </div>
                </div>
                <div className="text-[11.5px] text-muted mt-2">
                  Drag to orbit · scroll to zoom · right-drag to pan · drop files onto viewport or
                  sidebar to open
                </div>
              </Section>

              <Section title="Animation">
                {clips.length === 0 ? (
                  <div className="text-[12.5px] text-muted">This model has no animation clips.</div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => patchModel(active.id, { playing: !playing })}
                        className="bg-accent2 text-bg px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold hover:brightness-110 w-[76px]"
                      >
                        {playing ? '❚❚ Pause' : '▶ Play'}
                      </button>
                      <select
                        value={clipIndex}
                        onChange={(e) => changeClip(Number(e.target.value))}
                        className="bg-bg border border-border rounded-lg px-2 py-1.5 text-[12.5px] max-w-[240px]"
                      >
                        {clips.map((c, i) => (
                          <option key={`${c.name}-${i}`} value={i}>
                            {c.name} ({formatTime(c.duration)})
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        {SPEEDS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setSpeed(s)}
                            className={toggleClass(speed === s)}
                          >
                            {s}×
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-[11.5px] text-muted tabular-nums w-[52px]">
                        {formatTime(playhead.current)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(duration, 0.001)}
                        step={0.01}
                        value={Math.min(playhead.current, duration)}
                        onChange={(e) => seek(Number(e.target.value))}
                        disabled={!duration}
                        className="flex-1 accent-accent2"
                      />
                      <span className="text-[11.5px] text-muted tabular-nums w-[52px] text-right">
                        {formatTime(duration)}
                      </span>
                    </div>
                  </div>
                )}
              </Section>

              <Section
                title="Model Specifications"
                actions={
                  stats ? (
                    <div className="flex items-center gap-1.5">
                      {hiddenMeshes.length > 0 && (
                        <button
                          type="button"
                          onClick={() => patchModel(active.id, { hiddenMeshes: [] })}
                          className={ghostBtnClass}
                        >
                          Show all meshes ({hiddenMeshes.length} hidden)
                        </button>
                      )}
                      <button type="button" onClick={copySpecsJson} className={ghostBtnClass}>
                        Copy JSON
                      </button>
                    </div>
                  ) : null
                }
              >
                {!stats ? (
                  <div className="text-[12.5px] text-muted">Inspecting model…</div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                      <StatCard
                        label="Vertices"
                        value={formatNumber(stats.vertices)}
                        sub={`${formatNumber(stats.triangles)} triangles`}
                      />
                      <StatCard
                        label="Meshes"
                        value={formatNumber(stats.meshes)}
                        sub={
                          stats.skinnedMeshes
                            ? `${stats.skinnedMeshes} skinned · ${stats.nodes} nodes`
                            : `${formatNumber(stats.nodes)} scene nodes`
                        }
                      />
                      <StatCard
                        label="Materials"
                        value={formatNumber(stats.materials)}
                        sub={`${formatNumber(stats.textures)} texture${stats.textures === 1 ? '' : 's'}`}
                      />
                      <StatCard
                        label="Skeleton & Anim"
                        value={stats.bones ? `${formatNumber(stats.bones)} bones` : 'Static'}
                        sub={[
                          `${stats.animations} clip${stats.animations === 1 ? '' : 's'}`,
                          stats.morphTargets ? `${stats.morphTargets} morphs` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                      <StatCard
                        label="Dimensions (W×H×D)"
                        value={formatDimensions(stats.dimensions)}
                        sub={`View scale ${formatScale(stats.normalizedScale)}`}
                      />
                      <StatCard
                        label="Bounds Y / Center"
                        value={
                          stats.bounds
                            ? `${formatCoord(stats.bounds.min.y)} → ${formatCoord(stats.bounds.max.y)}`
                            : '—'
                        }
                        sub={stats.bounds ? `Center (${formatVec3(stats.bounds.center)})` : ''}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Chip accent>
                        {active.ext.toUpperCase()} · {formatBytes(active.size)}
                      </Chip>
                      {stats.formatInfo?.version && <Chip>glTF {stats.formatInfo.version}</Chip>}
                      {stats.formatInfo?.generator && (
                        <Chip title={stats.formatInfo.generator}>{stats.formatInfo.generator}</Chip>
                      )}
                      {stats.bounds && (
                        <Chip>
                          Min ({formatVec3(stats.bounds.min)}) · Max ({formatVec3(stats.bounds.max)}
                          )
                        </Chip>
                      )}
                      {stats.attributes?.map((attr) => (
                        <Chip key={attr}>{formatAttributeName(attr)}</Chip>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border">
                      {[
                        ['meshes', `Meshes (${stats.meshList?.length || 0})`],
                        ['materials', `Materials (${stats.materialList?.length || 0})`],
                        ['textures', `Textures (${stats.textureList?.length || 0})`],
                        ['clips', `Animations (${stats.clipList?.length || 0})`],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setInspectorTab((cur) => (cur === id ? null : id))}
                          className={toggleClass(inspectorTab === id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {inspectorTab === 'meshes' && (
                      <MeshTable
                        meshes={stats.meshList || []}
                        hiddenMeshes={hiddenMeshes}
                        onToggleMesh={toggleMeshVisibility}
                      />
                    )}
                    {inspectorTab === 'materials' && (
                      <MaterialTable materials={stats.materialList || []} />
                    )}
                    {inspectorTab === 'textures' && (
                      <TextureTable textures={stats.textureList || []} />
                    )}
                    {inspectorTab === 'clips' && (
                      <ClipTable
                        clips={stats.clipList || []}
                        activeIndex={clipIndex}
                        onSelect={changeClip}
                      />
                    )}
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
        <Toast toast={toast} />
      </ContentPane>
    </>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted truncate">{label}</div>
      <div
        className="text-[13.5px] font-semibold text-text tabular-nums truncate mt-0.5"
        title={value}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-[11px] text-muted truncate mt-0.5" title={sub}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Chip({ children, accent = false, title }) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 rounded-md border max-w-[320px] truncate ${
        accent
          ? 'bg-accent3/15 border-accent3/30 text-accent3 font-medium'
          : 'bg-bg border-border text-muted'
      }`}
    >
      {children}
    </span>
  );
}

function MeshTable({ meshes, hiddenMeshes, onToggleMesh }) {
  if (!meshes.length) {
    return <div className="text-[12.5px] text-muted">No meshes found in scene.</div>;
  }
  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-bg">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted">
            <th className="py-2 px-2.5 w-14">Show</th>
            <th className="py-2 px-2.5">Mesh</th>
            <th className="py-2 px-2.5">Type</th>
            <th className="py-2 px-2.5 text-right">Verts</th>
            <th className="py-2 px-2.5 text-right">Tris</th>
            <th className="py-2 px-2.5">Materials</th>
            <th className="py-2 px-2.5">Attributes</th>
          </tr>
        </thead>
        <tbody>
          {meshes.map((m) => {
            const hidden = hiddenMeshes.includes(m.key);
            return (
              <tr
                key={m.key}
                className={`border-b last:border-b-0 border-border/60 ${
                  hidden ? 'opacity-50' : ''
                }`}
              >
                <td className="py-1.5 px-2.5">
                  <button
                    type="button"
                    onClick={() => onToggleMesh(m.key)}
                    title={hidden ? 'Show mesh' : 'Hide mesh'}
                    className={`px-2 py-0.5 rounded border text-[11px] ${
                      hidden
                        ? 'border-border text-muted hover:text-text'
                        : 'border-accent2/40 bg-accent2/15 text-accent2'
                    }`}
                  >
                    {hidden ? 'Off' : 'On'}
                  </button>
                </td>
                <td className="py-1.5 px-2.5 font-medium max-w-[200px] truncate" title={m.name}>
                  {m.name}
                </td>
                <td className="py-1.5 px-2.5 text-muted whitespace-nowrap">{m.type}</td>
                <td className="py-1.5 px-2.5 text-right tabular-nums">
                  {formatNumber(m.vertices)}
                </td>
                <td className="py-1.5 px-2.5 text-right tabular-nums">
                  {formatNumber(m.triangles)}
                </td>
                <td
                  className="py-1.5 px-2.5 text-muted max-w-[180px] truncate"
                  title={m.materials.join(', ')}
                >
                  {m.materials.join(', ') || '—'}
                </td>
                <td className="py-1.5 px-2.5 text-muted">
                  {m.attributes.map(formatAttributeName).join(', ')}
                  {m.morphTargets ? ` · ${m.morphTargets} morph` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MaterialTable({ materials }) {
  if (!materials.length) {
    return <div className="text-[12.5px] text-muted">No materials found.</div>;
  }
  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-bg">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted">
            <th className="py-2 px-2.5">Material</th>
            <th className="py-2 px-2.5">Shader</th>
            <th className="py-2 px-2.5">Color</th>
            <th className="py-2 px-2.5 text-right">Rough / Metal</th>
            <th className="py-2 px-2.5">Flags</th>
            <th className="py-2 px-2.5">Texture Maps</th>
          </tr>
        </thead>
        <tbody>
          {materials.map((m, i) => (
            <tr key={`${m.name}-${i}`} className="border-b last:border-b-0 border-border/60">
              <td className="py-1.5 px-2.5 font-medium max-w-[200px] truncate" title={m.name}>
                {m.name}
              </td>
              <td className="py-1.5 px-2.5 text-muted whitespace-nowrap">{m.type}</td>
              <td className="py-1.5 px-2.5 whitespace-nowrap">
                {m.color ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
                    <span
                      className="w-3.5 h-3.5 rounded border border-border inline-block"
                      style={{ backgroundColor: m.color }}
                    />
                    {m.color}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="py-1.5 px-2.5 text-right tabular-nums text-muted whitespace-nowrap">
                {m.roughness != null || m.metalness != null
                  ? `${m.roughness ?? '—'} / ${m.metalness ?? '—'}`
                  : '—'}
              </td>
              <td className="py-1.5 px-2.5 text-muted whitespace-nowrap">
                {[
                  m.doubleSided ? '2-Sided' : 'Front',
                  m.transparent ? `Blend (${m.opacity})` : null,
                  m.alphaTest ? `Cutout (${m.alphaTest})` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </td>
              <td className="py-1.5 px-2.5 text-muted">{m.maps.join(', ') || 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextureTable({ textures }) {
  if (!textures.length) {
    return <div className="text-[12.5px] text-muted">No textures embedded or attached.</div>;
  }
  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-bg">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted">
            <th className="py-2 px-2.5">Texture</th>
            <th className="py-2 px-2.5">Used As</th>
            <th className="py-2 px-2.5 text-right">Resolution</th>
            <th className="py-2 px-2.5">Color Space</th>
          </tr>
        </thead>
        <tbody>
          {textures.map((t, i) => (
            <tr key={`${t.name}-${i}`} className="border-b last:border-b-0 border-border/60">
              <td className="py-1.5 px-2.5 font-medium max-w-[220px] truncate" title={t.name}>
                {t.name}
              </td>
              <td className="py-1.5 px-2.5 text-muted">{t.slots.join(', ') || '—'}</td>
              <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap">
                {t.width && t.height ? `${t.width} × ${t.height}` : '—'}
              </td>
              <td className="py-1.5 px-2.5 text-muted whitespace-nowrap">{t.colorSpace}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClipTable({ clips, activeIndex, onSelect }) {
  if (!clips.length) {
    return <div className="text-[12.5px] text-muted">No animation clips in this model.</div>;
  }
  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-bg">
      <table className="w-full text-left text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted">
            <th className="py-2 px-2.5">Clip</th>
            <th className="py-2 px-2.5 text-right">Duration</th>
            <th className="py-2 px-2.5 text-right">Tracks</th>
            <th className="py-2 px-2.5 text-right">Keyframes</th>
            <th className="py-2 px-2.5 w-20" />
          </tr>
        </thead>
        <tbody>
          {clips.map((c) => {
            const isCurrent = c.index === activeIndex;
            return (
              <tr
                key={`${c.name}-${c.index}`}
                className={`border-b last:border-b-0 border-border/60 ${
                  isCurrent ? 'bg-accent/[0.08]' : ''
                }`}
              >
                <td className="py-1.5 px-2.5 font-medium max-w-[240px] truncate" title={c.name}>
                  {c.name}
                </td>
                <td className="py-1.5 px-2.5 text-right tabular-nums whitespace-nowrap">
                  {formatTime(c.duration)}
                </td>
                <td className="py-1.5 px-2.5 text-right tabular-nums text-muted">
                  {formatNumber(c.tracks)}
                </td>
                <td className="py-1.5 px-2.5 text-right tabular-nums text-muted">
                  {formatNumber(c.keyframes)}
                </td>
                <td className="py-1.5 px-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => onSelect(c.index)}
                    className={`px-2 py-0.5 rounded border text-[11px] ${
                      isCurrent
                        ? 'border-accent2/40 bg-accent2/15 text-accent2'
                        : 'border-border text-muted hover:text-text'
                    }`}
                  >
                    {isCurrent ? 'Active' : 'Play'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ children }) {
  return (
    <span className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5 bg-accent3/20 text-accent3">
      {children}
    </span>
  );
}
