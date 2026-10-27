'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SubSidebar, SubItem, ContentPane } from '@/components/SubSidebar';
import { DropZone, Section, Toast, useToast } from '@/components/assets/Shared';
import ModelViewport from '@/components/model3d/ModelViewport';
import { ACCEPT_ATTR, detectFormat, describeStats, formatBytes, formatTime } from '@/lib/model3d';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
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
  // Every opened model stays in this list; the viewport only ever renders
  // `activeId`. Playhead, clip and stats are stored per model so switching
  // back to a model resumes where it was left.
  const [models, setModels] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [speed, setSpeed] = useState(1);
  const [playhead, setPlayhead] = useState({ current: 0, duration: 0 });
  const [seekRequest, setSeekRequest] = useState(null);
  const [resetSignal, setResetSignal] = useState(0);

  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(false);
  const [bg, setBg] = useState(BG_CHOICES[0].id);

  const inputRef = useRef(null);
  // id -> seconds. Kept out of state: it changes every animation frame and is
  // only read when a model is switched back to.
  const playheadsRef = useRef({});

  const active = models.find((m) => m.id === activeId) || null;
  // The viewport callbacks are memoised and fire from an animation loop, so
  // they read the active id from a ref rather than closing over a stale value.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const clipIndex = active?.clipIndex ?? 0;
  const clips = active?.clips ?? [];
  const playing = active?.playing ?? false;
  const duration = playhead.duration || clips[clipIndex]?.duration || 0;
  // Stable list for the viewport's cache pruning; `models` changes identity
  // whenever any model's stats update.
  const openIds = useMemo(() => models.map((m) => m.id), [models]);

  // Revoke every object URL on unmount so the blobs are released.
  const modelsRef = useRef(models);
  modelsRef.current = models;
  useEffect(
    () => () => {
      modelsRef.current.forEach((m) => URL.revokeObjectURL(m.url));
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
      const added = [];
      for (const file of files) {
        const ext = detectFormat(file.name);
        if (!ext) {
          show(`Unsupported file: ${file.name} (.glb/.gltf/.obj/.stl/.fbx)`, 'error');
          continue;
        }
        // The id doubles as the viewport's load key, so dropping the same
        // filename twice still produces a distinct entry and a fresh load.
        const id = `${file.name}-${file.size}-${Date.now()}-${added.length}`;
        added.push({
          id,
          key: id,
          url: URL.createObjectURL(file),
          ext,
          name: file.name,
          size: file.size,
          stats: null,
          clips: [],
          clipIndex: 0,
          playing: true,
        });
      }
      if (!added.length) return;
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

    // Promote a neighbour when the removed model was the one on screen.
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
    // The seek belongs to the model time is restored from, not the new one.
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
      if (!nextClips.length) show('Model loaded — no animations found.');
      // Only the model on screen owns the visible playhead; the others restore
      // theirs from playheadsRef when they are selected again.
      if (activeIdRef.current !== id) return;
      setPlayhead({
        current: playheadsRef.current[id] ?? 0,
        duration: nextClips[0]?.duration || 0,
      });
    },
    [patchModel, show]
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

  return (
    <>
      <SubSidebar
        title="3D Viewer"
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
          active={!models.length}
          onClick={() => inputRef.current?.click()}
          label="Open model"
          sub=".glb .gltf .obj .stl .fbx"
          icon={<Badge>◈</Badge>}
        />
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) openFiles(e.target.files);
            e.target.value = '';
          }}
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
      </SubSidebar>

      <ContentPane>
        <div className="bg-panel border border-border rounded-card px-4.5 pt-4.5 pb-4.5 flex flex-col gap-3.5">
          {!active ? (
            <DropZone onFiles={openFiles} accept={ACCEPT_ATTR} icon="◈" multiple>
              <div className="text-[13.5px] font-medium">Drop a 3D model here</div>
              <div className="text-[12px] text-muted">
                .glb .gltf .obj .stl .fbx — drop several to keep them side by side
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
                    {[formatBytes(active.size), describeStats(active.stats)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className={ghostBtnClass}
                  >
                    ＋ Open another
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

              <div className="h-[440px] min-h-[320px] bg-bg border border-border rounded-lg overflow-hidden">
                <ModelViewport
                  model={active}
                  openIds={openIds}
                  startTime={playheadsRef.current[active.id] ?? 0}
                  playing={playing}
                  clipIndex={clipIndex}
                  speed={speed}
                  wireframe={wireframe}
                  autoRotate={autoRotate}
                  showGrid={showGrid}
                  showAxes={showAxes}
                  bg={bg}
                  seekRequest={seekRequest}
                  resetSignal={resetSignal}
                  onLoaded={handleLoaded}
                  onTime={handleTime}
                  onError={handleError}
                />
              </div>

              <Section title="Animation">
                {clips.length === 0 ? (
                  <div className="text-[12.5px] text-muted">
                    This model has no animation clips. Try a rigged .glb/.fbx instead.
                  </div>
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
                        className="bg-bg border border-border rounded-lg px-2 py-1.5 text-[12.5px] max-w-[220px]"
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
                        className="flex-1 accent-[#3ecf8e]"
                      />
                      <span className="text-[11.5px] text-muted tabular-nums w-[52px] text-right">
                        {formatTime(duration)}
                      </span>
                    </div>
                  </div>
                )}
              </Section>

              <Section
                title="View"
                actions={
                  <button
                    type="button"
                    onClick={() => setResetSignal((n) => n + 1)}
                    className={ghostBtnClass}
                  >
                    Reset camera
                  </button>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setWireframe((v) => !v)}
                    className={toggleClass(wireframe)}
                  >
                    Wireframe
                  </button>
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
                        className={`w-6 h-6 rounded-md border ${bg === c.id ? 'border-accent' : 'border-border'}`}
                        style={{ backgroundColor: c.id }}
                      />
                    ))}
                  </div>
                </div>
                <div className="text-[11.5px] text-muted mt-2">
                  Drag to orbit · scroll to zoom · right-drag to pan
                </div>
              </Section>

              <DropZone
                onFiles={openFiles}
                accept={ACCEPT_ATTR}
                icon="⇪"
                className="!py-4"
                multiple
              >
                <div className="text-[12.5px] text-muted">
                  Drop a file to open it in a new tab above
                </div>
              </DropZone>
            </>
          )}
        </div>
        <Toast toast={toast} />
      </ContentPane>
    </>
  );
}

function Badge({ children }) {
  return (
    <span className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5 bg-accent3/20 text-accent3">
      {children}
    </span>
  );
}
