'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SubSidebar, SubItem, ContentPane } from '@/components/SubSidebar';
import { DropZone, Section, Toast, useToast } from '@/components/assets/Shared';
import ModelViewport from '@/components/model3d/ModelViewport';
import {
  ACCEPT_ATTR,
  detectFormat,
  describeStats,
  formatBytes,
  formatTime,
} from '@/lib/model3d';

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
  const [model, setModel] = useState(null);
  const [clips, setClips] = useState([]);
  const [clipIndex, setClipIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [stats, setStats] = useState(null);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [seekRequest, setSeekRequest] = useState(null);
  const [resetSignal, setResetSignal] = useState(0);

  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(false);
  const [bg, setBg] = useState(BG_CHOICES[0].id);

  const urlRef = useRef(null);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  const openFiles = useCallback(
    (fileList) => {
      const file = fileList?.[0];
      if (!file) return;
      const ext = detectFormat(file.name);
      if (!ext) {
        show(`Unsupported file: ${file.name} (.glb/.gltf/.obj/.stl/.fbx)`, 'error');
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setClips([]);
      setClipIndex(0);
      setStats(null);
      setTime({ current: 0, duration: 0 });
      setPlaying(true);
      setModel({ url, ext, name: file.name, size: file.size, key: `${file.name}-${Date.now()}` });
    },
    [show]
  );

  const closeModel = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setModel(null);
    setClips([]);
    setStats(null);
  }, []);

  const handleLoaded = useCallback(
    (nextStats, nextClips) => {
      setStats(nextStats);
      setClips(nextClips);
      setClipIndex(0);
      setTime({ current: 0, duration: nextClips[0]?.duration || 0 });
      if (!nextClips.length) {
        setPlaying(false);
        show('Model loaded — no animations found.');
      }
    },
    [show]
  );

  const handleTime = useCallback((current, duration) => {
    setTime({ current, duration });
  }, []);

  const handleError = useCallback(
    (msg) => {
      show(msg, 'error');
      closeModel();
    },
    [show, closeModel]
  );

  const duration = time.duration || clips[clipIndex]?.duration || 0;

  return (
    <>
      <SubSidebar
        title="3D Viewer"
        action={
          model ? (
            <button type="button" onClick={closeModel} title="Close model" className={ghostBtnClass}>
              ✕
            </button>
          ) : null
        }
      >
        <SubItem
          active={!model}
          onClick={() => {}}
          label="Open model"
          sub=".glb .gltf .obj .stl .fbx"
          icon={<Badge>◈</Badge>}
        />
        {model && (
          <div className="mt-2 px-2.5 py-2 rounded-[9px] border border-border bg-panel text-[11.5px] text-muted break-words">
            <div className="text-text font-medium text-[12.5px] truncate" title={model.name}>
              {model.name}
            </div>
            <div className="mt-1">
              {formatBytes(model.size)}
              {describeStats(stats) ? ` · ${describeStats(stats)}` : ''}
            </div>
          </div>
        )}
      </SubSidebar>

      <ContentPane>
        <div className="bg-panel border border-border rounded-card px-4.5 pt-4.5 pb-4.5 flex flex-col gap-3.5">
          {!model ? (
            <DropZone onFiles={openFiles} accept={ACCEPT_ATTR} icon="◈">
              <div className="text-[13.5px] font-medium">Drop a 3D model here</div>
              <div className="text-[12px] text-muted">.glb .gltf .obj .stl .fbx</div>
            </DropZone>
          ) : (
            <>
              <div className="h-[440px] min-h-[320px] bg-bg border border-border rounded-lg overflow-hidden">
                <ModelViewport
                  model={model}
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
                        onClick={() => setPlaying((v) => !v)}
                        className="bg-accent2 text-bg px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold hover:brightness-110 w-[76px]"
                      >
                        {playing ? '❚❚ Pause' : '▶ Play'}
                      </button>
                      <select
                        value={clipIndex}
                        onChange={(e) => setClipIndex(Number(e.target.value))}
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
                        {formatTime(time.current)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(duration, 0.001)}
                        step={0.01}
                        value={Math.min(time.current, duration)}
                        onChange={(e) =>
                          setSeekRequest({ time: Number(e.target.value), nonce: Date.now() })
                        }
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
                  <button type="button" onClick={() => setResetSignal((n) => n + 1)} className={ghostBtnClass}>
                    Reset camera
                  </button>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setWireframe((v) => !v)} className={toggleClass(wireframe)}>
                    Wireframe
                  </button>
                  <button type="button" onClick={() => setAutoRotate((v) => !v)} className={toggleClass(autoRotate)}>
                    Auto-rotate
                  </button>
                  <button type="button" onClick={() => setShowGrid((v) => !v)} className={toggleClass(showGrid)}>
                    Grid
                  </button>
                  <button type="button" onClick={() => setShowAxes((v) => !v)} className={toggleClass(showAxes)}>
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

              <DropZone onFiles={openFiles} accept={ACCEPT_ATTR} icon="⇪" className="!py-4">
                <div className="text-[12.5px] text-muted">Drop another file to replace this model</div>
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
    <span className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[11px] flex-shrink-0 mt-0.5 bg-accent3/20 text-accent3">
      {children}
    </span>
  );
}
