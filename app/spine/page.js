'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar, SubItem, ContentPane } from '@/components/Sidebar';
import { DropZone, Section, Toast, useToast } from '@/components/assets/Shared';
import SpineViewport from '@/components/spine/SpineViewport';
import {
  ACCEPT_ATTR,
  detectVersionFromJson,
  detectVersionFromSkel,
  groupSpineFiles,
  resolveAtlasPages,
  runtimeKeyForVersion,
} from '@/lib/spine';
import { formatBytes, formatTime } from '@/lib/model3d';
import { downloadBlob, readZip } from '@/lib/zip';

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
    on ? 'bg-accent2/[0.14] border-accent2/40 text-text' : ghostBtnClass
  }`;

export default function SpinePage() {
  const { toast, show } = useToast();
  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [mixDuration, setMixDuration] = useState(0.25);
  const [playhead, setPlayhead] = useState({ current: 0, duration: 0 });
  const [seekRequest, setSeekRequest] = useState(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [command, setCommand] = useState(null);
  const [debug, setDebug] = useState({
    bones: false,
    regionAttachments: false,
    boundingBoxes: false,
    meshTriangles: false,
  });
  const [pma, setPma] = useState(null);
  const [bg, setBg] = useState(BG_CHOICES[0].id);
  const [recording, setRecording] = useState(false);
  const [snapshotSignal, setSnapshotSignal] = useState(0);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const active = items.find((i) => i.id === activeId) || null;
  const skinName = active?.skinName ?? '';
  const customSkins = active?.customSkins ?? [];
  const effectivePma = pma ?? active?.defaultPma ?? false;
  const playing = active?.playing ?? true;
  const tracks = active?.tracks ?? [];

  useEffect(
    () => () => {
      itemsRef.current.forEach(revokeItemUrls);
    },
    []
  );

  const patchItem = useCallback((id, patch) => {
    itemsRef.current = itemsRef.current.map((i) => (i.id === id ? { ...i, ...patch } : i));
    setItems(itemsRef.current);
  }, []);

  const openFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      try {
        const entries = [];
        for (const file of files) {
          if (/\.zip$/i.test(file.name)) {
            entries.push(...(await readZip(file)));
          } else {
            entries.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
          }
        }

        const groups = groupSpineFiles(entries);
        if (!groups.length) {
          show('No Spine skeleton (.json/.skel) found in those files.', 'error');
          return;
        }

        const decoder = new TextDecoder();
        const added = [];
        for (const rawGroup of groups) {
          const atlasText = rawGroup.atlas ? decoder.decode(rawGroup.atlas.bytes) : '';
          const group = resolveAtlasPages(rawGroup, atlasText);
          const isJson = /\.json$/i.test(group.skeleton.name);
          const skeletonText = isJson ? decoder.decode(group.skeleton.bytes) : null;
          const version = isJson
            ? detectVersionFromJson(skeletonText)
            : detectVersionFromSkel(group.skeleton.bytes);
          const runtimeKey = runtimeKeyForVersion(version);

          if (!runtimeKey) {
            show(
              `${group.skeleton.name}: Spine ${version || 'unknown version'} is not supported (only 3.8.99, 4.1, 4.2).`,
              'error'
            );
            continue;
          }
          if (group.missing.length) {
            show(`${group.skeleton.name}: missing ${group.missing.join(', ')}.`, 'error');
            continue;
          }

          const pageUrls = new Map();
          for (const page of group.pages) {
            const entry = group.images.get(page.split(/[\\/]/).pop().toLowerCase());
            const blob = new Blob([entry.bytes], { type: 'image/png' });
            pageUrls.set(page.split(/[\\/]/).pop().toLowerCase(), URL.createObjectURL(blob));
          }

          added.push({
            id: `${group.skeleton.name}-${Date.now()}-${added.length}`,
            name: group.skeleton.name,
            size: group.skeleton.bytes.length,
            version,
            runtimeKey,
            atlasText,
            pageUrls,
            skeletonText,
            skeletonBytes: isJson ? undefined : group.skeleton.bytes,
            animations: [],
            skins: [],
            skinName: '',
            customSkins: [],
            tracks: [],
            playing: true,
          });
        }

        if (!added.length) return;
        itemsRef.current = [...itemsRef.current, ...added];
        setItems(itemsRef.current);
        setActiveId(added[0].id);
      } catch (err) {
        show(err?.message || String(err), 'error');
      }
    },
    [show]
  );

  const removeItem = useCallback((id) => {
    const removed = itemsRef.current.find((i) => i.id === id);
    if (removed) revokeItemUrls(removed);
    const next = itemsRef.current.filter((i) => i.id !== id);
    itemsRef.current = next;
    setItems(next);
    if (activeIdRef.current === id) setActiveId(next[0]?.id ?? null);
  }, []);

  const closeAll = useCallback(() => {
    itemsRef.current.forEach(revokeItemUrls);
    itemsRef.current = [];
    setItems([]);
    setActiveId(null);
  }, []);

  const send = useCallback(
    (cmd) => setCommand({ ...cmd, nonce: Date.now() + Math.random() }),
    []
  );

  const playOnTrack0 = useCallback(
    (name) => {
      const current = tracks.find((t) => t.track === 0)?.name;
      send({
        type: 'setTrack',
        track: 0,
        name,
        loop,
        mixFrom: current && current !== name ? current : null,
        mixDuration,
      });
    },
    [loop, mixDuration, send, tracks]
  );

  const addToTrack = useCallback(
    (name) => {
      const nextTrack = tracks.length ? Math.max(...tracks.map((t) => t.track)) + 1 : 1;
      send({ type: 'setTrack', track: nextTrack, name, loop });
    },
    [loop, send, tracks]
  );

  const handleLoaded = useCallback(
    (id, meta) => {
      const current = itemsRef.current.find((i) => i.id === id);
      patchItem(id, {
        ...meta,
        skinName: current?.skinName || meta.skins[0] || '',
        customSkins: current?.customSkins ?? [],
      });
    },
    [patchItem]
  );

  const handleTime = useCallback((id, current, duration) => {
    if (id !== activeIdRef.current) return;
    setPlayhead((prev) =>
      prev.current === current && prev.duration === duration ? prev : { current, duration }
    );
  }, []);

  const handleTracks = useCallback(
    (id, nextTracks) => patchItem(id, { tracks: nextTracks }),
    [patchItem]
  );

  const handleError = useCallback(
    (msg, id) => {
      show(msg, 'error');
      if (id) removeItem(id);
    },
    [removeItem, show]
  );

  return (
    <>
      <Sidebar
        title="Spine Viewer"
        activeLabel={active ? active.name : 'Open skeleton'}
        action={
          items.length ? (
            <button type="button" onClick={closeAll} title="Close all" className={ghostBtnClass}>
              ✕
            </button>
          ) : null
        }
      >
        <SubItem
          active={activeId === null}
          onClick={() => setActiveId(null)}
          label="Open skeleton"
          sub="Drop files below · .json/.skel + .atlas + .png, or .zip"
          icon={<Badge>SP</Badge>}
        />
        {items.map((item) => (
          <div key={item.id} className="flex items-stretch gap-1 group">
            <div className="flex-1 min-w-0">
              <SubItem
                active={item.id === activeId}
                onClick={() => setActiveId(item.id)}
                label={item.name}
                sub={`Spine ${item.version} · ${formatBytes(item.size)}`}
                icon={<Badge>{item.runtimeKey}</Badge>}
              />
            </div>
            <button
              type="button"
              onClick={() => removeItem(item.id)}
              title={`Close ${item.name}`}
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
            <DropZone onFiles={openFiles} accept={ACCEPT_ATTR} icon="SP" multiple>
              <div className="text-[13.5px] font-medium">Drop a Spine skeleton here</div>
              <div className="text-[12px] text-muted">
                .json/.skel + .atlas + texture .png — or one .zip with everything
              </div>
              <div className="text-[11.5px] text-muted">
                Spine 3.8.99, 4.1 and 4.2 exports are supported; the version is detected
                automatically
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
                    Spine {active.version} · runtime {active.runtimeKey} ·{' '}
                    {formatBytes(active.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeItem(active.id)}
                  className={ghostBtnClass}
                >
                  Close
                </button>
              </div>

              <div className="h-[440px] min-h-[320px] bg-bg border border-border rounded-lg overflow-hidden">
                <SpineViewport
                  item={active}
                  playing={playing}
                  speed={speed}
                  seekRequest={seekRequest}
                  resetSignal={resetSignal}
                  command={command}
                  debug={debug}
                  premultipliedAlpha={effectivePma}
                  bg={bg}
                  recording={recording}
                  snapshotSignal={snapshotSignal}
                  onLoaded={handleLoaded}
                  onTime={handleTime}
                  onTracks={handleTracks}
                  onSnapshot={(blob) =>
                    downloadBlob(blob, `${active.name.replace(/\.[^.]+$/, '')}.png`)
                  }
                  onRecorded={(blob) =>
                    downloadBlob(blob, `${active.name.replace(/\.[^.]+$/, '')}.webm`)
                  }
                  onError={handleError}
                />
              </div>

              <Section title="Playback">
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => patchItem(active.id, { playing: !playing })}
                      className="bg-accent2 text-bg px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold hover:brightness-110 w-[76px]"
                    >
                      {playing ? '❚❚ Pause' : '▶ Play'}
                    </button>
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
                    <button
                      type="button"
                      onClick={() => setLoop((v) => !v)}
                      className={toggleClass(loop)}
                    >
                      Loop
                    </button>
                    <label className="flex items-center gap-2 text-[12.5px] text-muted ml-1">
                      Mix
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={mixDuration}
                        onChange={(e) => setMixDuration(Number(e.target.value))}
                        className="w-24 accent-[#3ecf8e]"
                      />
                      {mixDuration.toFixed(2)}s
                    </label>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="text-[11.5px] text-muted tabular-nums w-[52px]">
                      {formatTime(playhead.current)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(playhead.duration, 0.001)}
                      step={0.01}
                      value={Math.min(playhead.current, playhead.duration)}
                      onChange={(e) => {
                        const time = Number(e.target.value);
                        setPlayhead((prev) => ({ ...prev, current: time }));
                        setSeekRequest({ time, nonce: Date.now() });
                      }}
                      disabled={!playhead.duration}
                      className="flex-1 accent-[#3ecf8e]"
                    />
                    <span className="text-[11.5px] text-muted tabular-nums w-[52px] text-right">
                      {formatTime(playhead.duration)}
                    </span>
                  </div>
                </div>
              </Section>

              <Section title="Animations">
                {active.animations.length === 0 ? (
                  <div className="text-[12.5px] text-muted">Loading…</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {active.animations.map((a) => (
                      <span
                        key={a.name}
                        className="inline-flex items-center gap-1 bg-panel2 border border-border rounded-lg pl-2.5 pr-1 py-1"
                      >
                        <button
                          type="button"
                          onClick={() => playOnTrack0(a.name)}
                          className="text-[12.5px] hover:text-accent2"
                          title="Play on track 0 with mix"
                        >
                          {a.name}
                          <span className="text-muted"> ({formatTime(a.duration)})</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => addToTrack(a.name)}
                          className={ghostBtnClass}
                          title="Add on a new track"
                        >
                          + track
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {tracks.length > 0 && (
                  <div className="flex flex-col gap-1 mt-2.5">
                    {tracks.map((t) => (
                      <div
                        key={t.track}
                        className="flex items-center gap-2 text-[12.5px] bg-panel2 border border-border rounded-lg px-2.5 py-1.5"
                      >
                        <span className="text-muted">Track {t.track}</span>
                        <span className="flex-1 min-w-0 truncate">{t.name}</span>
                        <span className="text-muted tabular-nums">
                          {formatTime(t.time)} / {formatTime(t.duration)}
                          {t.loop ? ' · loop' : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            send({ type: 'clearTrack', track: t.track, mixDuration })
                          }
                          className={ghostBtnClass}
                        >
                          Clear
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Skins">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={skinName}
                    onChange={(e) => {
                      patchItem(active.id, { skinName: e.target.value, customSkins: [] });
                      send({ type: 'setSkin', name: e.target.value });
                    }}
                    className="bg-bg border border-border rounded-lg px-2 py-1.5 text-[12.5px] max-w-[220px]"
                  >
                    {skinName === '' && <option value="">(combined skin)</option>}
                    {active.skins.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <span className="text-[12px] text-muted">or combine:</span>
                  {active.skins.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() =>
                        patchItem(active.id, {
                          customSkins: customSkins.includes(name)
                            ? customSkins.filter((n) => n !== name)
                            : [...customSkins, name],
                        })
                      }
                      className={toggleClass(customSkins.includes(name))}
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={!customSkins.length}
                    onClick={() => {
                      patchItem(active.id, { skinName: '' });
                      send({ type: 'customSkin', names: customSkins });
                    }}
                    className="bg-accent2 text-bg px-3 py-1.5 rounded-lg text-[12.5px] font-semibold hover:brightness-110 disabled:opacity-40"
                  >
                    Apply combined skin
                  </button>
                </div>
              </Section>

              <Section
                title="View"
                actions={
                  <button
                    type="button"
                    onClick={() => setResetSignal((n) => n + 1)}
                    className={ghostBtnClass}
                  >
                    Fit camera
                  </button>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    ['bones', 'Bones'],
                    ['regionAttachments', 'Slots'],
                    ['boundingBoxes', 'Bounds'],
                    ['meshTriangles', 'Mesh'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDebug((d) => ({ ...d, [key]: !d[key] }))}
                      className={toggleClass(debug[key])}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setPma(!effectivePma)}
                    className={toggleClass(effectivePma)}
                    title="Premultiplied alpha — turn off if edges look dark or fringed"
                  >
                    Premultiplied α
                  </button>
                  <div className="flex items-center gap-1 ml-1">
                    {BG_CHOICES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        title={c.label}
                        onClick={() => setBg(c.id)}
                        className={`w-6 h-6 rounded-md border ${bg === c.id ? 'border-accent2' : 'border-border'}`}
                        style={{ backgroundColor: c.id }}
                      />
                    ))}
                  </div>
                </div>
                <div className="text-[11.5px] text-muted mt-2">
                  Drag to pan · scroll to zoom
                </div>
              </Section>

              <Section title="Export">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSnapshotSignal((n) => n + 1)}
                    className={ghostBtnClass}
                  >
                    Snapshot PNG
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecording((v) => !v)}
                    className={recording ? toggleClass(true) : ghostBtnClass}
                  >
                    {recording ? '■ Stop recording' : '● Record WebM'}
                  </button>
                </div>
              </Section>
            </>
          )}
        </div>
        <Toast toast={toast} />
      </ContentPane>
    </>
  );
}

function revokeItemUrls(item) {
  for (const url of item.pageUrls.values()) URL.revokeObjectURL(url);
}

function Badge({ children }) {
  return (
    <span className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5 bg-accent2/20 text-accent2">
      {children}
    </span>
  );
}
