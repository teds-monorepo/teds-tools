'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, SubItem, ContentPane } from '@/components/Sidebar';
import { DropZone, Section, Toast, useToast } from '@/components/assets/Shared';
import SpineViewport from '@/components/spine/SpineViewport';
import {
  ACCEPT_ATTR,
  baseSpineName,
  describeSpineStats,
  detectVersionFromJson,
  detectVersionFromSkel,
  groupSpineFiles,
  isAtlasFile,
  isCompanionSpineFile,
  isImageFile,
  isJsonSkeletonFile,
  resolveAtlasPages,
  runtimeKeyForVersion,
  runtimeLabelForKey,
} from '@/lib/spine';
import { formatBytes, formatCoord, formatNumber, formatTime } from '@/lib/model3d';
import { downloadBlob, readZip } from '@/lib/zip';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const BG_CHOICES = [
  { id: '#0b0e1a', label: 'Dark' },
  { id: '#1a1f33', label: 'Panel' },
  { id: '#e8eaf3', label: 'Light' },
  { id: '#000000', label: 'Black' },
];

const ghostBtnClass =
  'bg-transparent border border-border text-muted hover:text-text px-2.5 py-1.5 rounded-lg text-[12px]';
const toggleClass = (on) =>
  `px-2.5 py-1.5 rounded-lg text-[12px] border ${
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

  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(false);
  const [debug, setDebug] = useState({
    bones: false,
    regionAttachments: false,
    boundingBoxes: false,
    meshTriangles: false,
    paths: false,
    clipping: false,
  });
  const [bg, setBg] = useState(BG_CHOICES[0].id);
  const [recording, setRecording] = useState(false);
  const [snapshotSignal, setSnapshotSignal] = useState(0);
  const [inspectorTab, setInspectorTab] = useState('slots');

  const fileInputRef = useRef(null);
  const playheadsRef = useRef({});
  const companionsRef = useRef({ atlases: new Map(), images: new Map() });

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const active = items.find((i) => i.id === activeId) || null;
  const openIds = useMemo(() => items.map((i) => i.id), [items]);
  const skinName = active?.skinName ?? '';
  const customSkins = active?.customSkins ?? [];
  const effectivePma = active?.pmaOverride ?? active?.defaultPma ?? false;
  const playing = active?.playing ?? true;
  const tracks = active?.tracks ?? [];
  const hiddenSlots = active?.hiddenSlots ?? [];
  const stats = active?.stats ?? null;
  const track0Anim = tracks.find((t) => t.track === 0)?.name ?? '';

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

        let companionAdded = 0;
        for (const entry of entries) {
          if (isAtlasFile(entry.name)) {
            companionsRef.current.atlases.set(baseSpineName(entry.name), entry);
            companionAdded++;
          } else if (isImageFile(entry.name)) {
            companionsRef.current.images.set(baseSpineName(entry.name), entry);
            companionAdded++;
          }
        }

        const groups = groupSpineFiles(entries, companionsRef.current);
        if (!groups.length) {
          if (companionAdded > 0 && entries.every((e) => isCompanionSpineFile(e.name))) {
            show('Atlas/textures staged — now drop the .json or .skel file.');
          } else {
            show('No Spine skeleton (.json/.skel) found in those files.', 'error');
          }
          return;
        }

        const decoder = new TextDecoder();
        const added = [];
        for (const rawGroup of groups) {
          const atlasText = rawGroup.atlas ? decoder.decode(rawGroup.atlas.bytes) : '';
          const group = resolveAtlasPages(rawGroup, atlasText);
          const isJson = isJsonSkeletonFile(group.skeleton.name);
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
          const pageSizes = new Map();
          let imageBytesTotal = 0;
          for (const page of group.pages) {
            const key = baseSpineName(page);
            const entry = group.images.get(key);
            const mime = /\.jpe?g$/i.test(key)
              ? 'image/jpeg'
              : /\.webp$/i.test(key)
                ? 'image/webp'
                : 'image/png';
            const blob = new Blob([entry.bytes], { type: mime });
            pageUrls.set(key, URL.createObjectURL(blob));
            pageSizes.set(key, entry.bytes.length);
            imageBytesTotal += entry.bytes.length;
          }

          const totalBytes =
            group.skeleton.bytes.length + (rawGroup.atlas?.bytes.length || 0) + imageBytesTotal;

          added.push({
            id: `${group.skeleton.name}-${Date.now()}-${added.length}`,
            name: group.skeleton.name,
            format: isJson ? 'JSON' : 'SKEL',
            size: group.skeleton.bytes.length,
            totalBytes,
            version,
            runtimeKey,
            atlasText,
            pageUrls,
            pageSizes,
            skeletonText,
            skeletonBytes: isJson ? undefined : group.skeleton.bytes,
            animations: [],
            skins: [],
            skinName: '',
            customSkins: [],
            tracks: [],
            hiddenSlots: [],
            pmaOverride: null,
            stats: null,
            playing: true,
          });
        }

        if (!added.length) return;
        itemsRef.current = [...itemsRef.current, ...added];
        setItems(itemsRef.current);
        setActiveId(added[0].id);
        setSeekRequest(null);
        setPlayhead({ current: 0, duration: 0 });
      } catch (err) {
        show(err?.message || String(err), 'error');
      }
    },
    [show]
  );

  const removeItem = useCallback((id) => {
    const current = itemsRef.current;
    const removed = current.find((i) => i.id === id);
    if (!removed) return;
    revokeItemUrls(removed);
    delete playheadsRef.current[id];
    const next = current.filter((i) => i.id !== id);
    itemsRef.current = next;
    setItems(next);
    if (activeIdRef.current === id) {
      const promoted = next[0] ?? null;
      setActiveId(promoted?.id ?? null);
      setSeekRequest(null);
      setPlayhead(
        promoted
          ? (playheadsRef.current[promoted.id] ?? { current: 0, duration: 0 })
          : { current: 0, duration: 0 }
      );
    }
  }, []);

  const closeAll = useCallback(() => {
    setRecording(false);
    itemsRef.current.forEach(revokeItemUrls);
    companionsRef.current = { atlases: new Map(), images: new Map() };
    playheadsRef.current = {};
    itemsRef.current = [];
    setItems([]);
    setActiveId(null);
    setSeekRequest(null);
    setPlayhead({ current: 0, duration: 0 });
  }, []);

  const selectItem = useCallback((id) => {
    if (id === activeIdRef.current) return;
    const target = itemsRef.current.find((i) => i.id === id);
    if (!target) return;
    setRecording(false);
    setSeekRequest(null);
    setActiveId(id);
    setPlayhead(playheadsRef.current[id] ?? { current: 0, duration: 0 });
  }, []);

  const handleOpenMenuClick = useCallback(() => {
    if (activeIdRef.current === null) {
      fileInputRef.current?.click();
      return;
    }
    setRecording(false);
    setSeekRequest(null);
    setActiveId(null);
    setPlayhead({ current: 0, duration: 0 });
  }, []);

  const send = useCallback(
    (cmd) =>
      setCommand({
        ...cmd,
        itemId: activeIdRef.current,
        nonce: Date.now() + Math.random(),
      }),
    []
  );

  const playOnTrack0 = useCallback(
    (name) => {
      if (!active) return;
      if (!name) {
        send({ type: 'clearTracks' });
        return;
      }
      const current = tracks.find((t) => t.track === 0)?.name;
      send({
        type: 'setTrack',
        track: 0,
        name,
        loop,
        mixFrom: current && current !== name && current !== '(empty)' ? current : null,
        mixDuration,
      });
    },
    [active, loop, mixDuration, send, tracks]
  );

  const addToTrack = useCallback(
    (name) => {
      if (!name) return;
      const nextTrack = tracks.length ? Math.max(...tracks.map((t) => t.track)) + 1 : 1;
      send({ type: 'setTrack', track: nextTrack, name, loop });
    },
    [loop, send, tracks]
  );

  const toggleSlotVisibility = useCallback(
    (slotName) => {
      if (!active) return;
      const current = active.hiddenSlots || [];
      const next = current.includes(slotName)
        ? current.filter((n) => n !== slotName)
        : [...current, slotName];
      patchItem(active.id, { hiddenSlots: next });
    },
    [active, patchItem]
  );

  const selectSingleSkin = useCallback(
    (name) => {
      if (!active || !name) return;
      patchItem(active.id, { skinName: name, customSkins: [] });
      send({ type: 'setSkin', name });
    },
    [active, patchItem, send]
  );

  const toggleCombinedSkin = useCallback(
    (name) => {
      if (!active) return;
      const next = customSkins.includes(name)
        ? customSkins.filter((n) => n !== name)
        : [...customSkins, name];
      patchItem(active.id, { customSkins: next });
    },
    [active, customSkins, patchItem]
  );

  const applyCombinedSkins = useCallback(() => {
    if (!active || !customSkins.length) return;
    patchItem(active.id, { skinName: '' });
    send({ type: 'customSkin', names: customSkins });
  }, [active, customSkins, patchItem, send]);

  const copySpecsJson = useCallback(() => {
    if (!active || !stats) return;
    const payload = {
      name: active.name,
      format: active.format,
      spineVersion: active.version,
      runtime: runtimeLabelForKey(active.runtimeKey),
      skeletonBytes: active.size,
      totalBundleBytes: active.totalBytes,
      totalBundleFormatted: formatBytes(active.totalBytes),
      ...stats,
    };
    navigator.clipboard
      ?.writeText(JSON.stringify(payload, null, 2))
      .then(() => show('Copied skeleton specs JSON'))
      .catch(() => show('Could not copy to clipboard', 'error'));
  }, [active, stats, show]);

  const handleLoaded = useCallback(
    (id, meta) => {
      const current = itemsRef.current.find((i) => i.id === id);
      const defaultSkin = current?.skinName || meta.initialSkin || meta.skins?.[0] || '';
      patchItem(id, {
        ...meta,
        skinName: current?.customSkins?.length ? '' : defaultSkin,
        customSkins: current?.customSkins ?? [],
      });
    },
    [patchItem]
  );

  const handleTime = useCallback((id, current, duration) => {
    playheadsRef.current[id] = { current, duration };
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

  const upperTracks = tracks.filter((t) => t.track > 0);

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
        title="Spine Viewer"
        activeLabel={active ? active.name : 'Open skeleton'}
        action={
          items.length ? (
            <button
              type="button"
              onClick={closeAll}
              title="Close all skeletons"
              className={ghostBtnClass}
            >
              ✕
            </button>
          ) : null
        }
      >
        <SubItem
          active={activeId === null}
          onClick={handleOpenMenuClick}
          onFilesDrop={openFiles}
          dropSub="Drop files to open skeleton"
          label="Open skeleton"
          sub="Click or drop files · .json .skel .atlas .png .zip"
          icon={<Badge>SP</Badge>}
        />
        {items.map((item) => (
          <div key={item.id} className="flex items-stretch gap-1 group">
            <div className="flex-1 min-w-0">
              <SubItem
                active={item.id === activeId}
                onClick={() => selectItem(item.id)}
                label={item.name}
                sub={[
                  `v${item.version}`,
                  formatBytes(item.totalBytes || item.size),
                  describeSpineStats(item.stats) || 'Loading…',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon={<Badge>{runtimeLabelForKey(item.runtimeKey)}</Badge>}
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

      <ContentPane padded={false} scroll={false}>
        {!active ? (
          <div className="h-full overflow-y-auto px-4 py-5 pb-16 sm:px-6 lg:p-5 flex flex-col">
            <div className="bg-panel border border-border rounded-card p-4.5 lg:flex-1 lg:min-h-[360px] flex flex-col">
              <DropZone
                onFiles={openFiles}
                accept={ACCEPT_ATTR}
                icon="SP"
                multiple
                className="lg:flex-1"
              >
                <div className="text-[14px] font-medium">Drop a Spine skeleton here</div>
                <div className="text-[12.5px] text-muted">
                  .json/.skel + .atlas + texture .png, or .zip — drop several to inspect side by
                  side
                </div>
                <div className="text-[11.5px] text-muted">
                  Spine 3.8.99, 4.1 and 4.2 auto-detected · you can also drop onto Open skeleton in
                  the sidebar
                </div>
              </DropZone>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 overflow-y-auto lg:overflow-hidden px-4 py-5 pb-16 sm:px-6 lg:p-0">
            <div className="bg-panel border border-border rounded-card p-3.5 sm:p-4.5 flex flex-col gap-3.5 lg:bg-transparent lg:border-0 lg:rounded-none lg:p-0 lg:h-full lg:flex-row lg:gap-0">
              {/* ── Center Spine Preview Stage ───────────────────────────── */}
              <div className="flex flex-col lg:flex-1 lg:min-w-0 lg:min-h-0 lg:h-full lg:p-3.5">
                <div className="h-[380px] sm:h-[440px] lg:h-auto lg:flex-1 lg:min-h-0 bg-bg border border-border rounded-lg lg:rounded-card overflow-hidden">
                  <SpineViewport
                    item={active}
                    openIds={openIds}
                    playing={playing}
                    speed={speed}
                    flipX={flipX}
                    flipY={flipY}
                    hiddenSlots={hiddenSlots}
                    showGrid={showGrid}
                    showAxes={showAxes}
                    debug={debug}
                    premultipliedAlpha={effectivePma}
                    bg={bg}
                    seekRequest={seekRequest}
                    resetSignal={resetSignal}
                    command={command}
                    recording={recording}
                    snapshotSignal={snapshotSignal}
                    onFilesDrop={openFiles}
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
              </div>

              {/* ── Right Inspector & Controls Panel (desktop) / Below (mobile) ── */}
              <aside className="flex flex-col gap-3 lg:w-[390px] xl:w-[430px] lg:flex-shrink-0 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:bg-panel lg:border-l lg:border-border lg:p-3.5">
                <Section
                  title="View"
                  actions={
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => send({ type: 'clearTracks' })}
                        title="Clear active tracks and reset to setup pose"
                        className={ghostBtnClass}
                      >
                        Setup pose
                      </button>
                      <button
                        type="button"
                        onClick={() => setResetSignal((n) => n + 1)}
                        className={ghostBtnClass}
                      >
                        Reset
                      </button>
                    </div>
                  }
                >
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setFlipX((v) => !v)}
                          className={toggleClass(flipX)}
                        >
                          Flip X
                        </button>
                        <button
                          type="button"
                          onClick={() => setFlipY((v) => !v)}
                          className={toggleClass(flipY)}
                        >
                          Flip Y
                        </button>
                        <button
                          type="button"
                          onClick={() => patchItem(active.id, { pmaOverride: !effectivePma })}
                          title="Premultiplied alpha — toggle if edges look dark or fringed"
                          className={toggleClass(effectivePma)}
                        >
                          PMA α
                        </button>
                      </div>
                      <div className="flex items-center gap-1">
                        {BG_CHOICES.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            title={`Background: ${c.label}`}
                            onClick={() => setBg(c.id)}
                            className={`w-6 h-6 rounded-md border ${
                              bg === c.id ? 'border-accent2' : 'border-border'
                            }`}
                            style={{ backgroundColor: c.id }}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
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
                      {[
                        ['bones', 'Bones'],
                        ['regionAttachments', 'Regions'],
                        ['meshTriangles', 'Mesh'],
                        ['boundingBoxes', 'Bounds'],
                        ['paths', 'Paths'],
                        ['clipping', 'Clipping'],
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
                    </div>

                    <div className="flex items-center gap-1.5 pt-2 border-t border-border/60">
                      <button
                        type="button"
                        onClick={() => setSnapshotSignal((n) => n + 1)}
                        className={`flex-1 ${ghostBtnClass}`}
                      >
                        Snapshot PNG
                      </button>
                      <button
                        type="button"
                        onClick={() => setRecording((v) => !v)}
                        className={`flex-1 ${
                          recording
                            ? 'px-2.5 py-1.5 rounded-lg text-[12px] border border-red-400/40 bg-red-400/15 text-red-400'
                            : ghostBtnClass
                        }`}
                      >
                        {recording ? '■ Stop WebM' : '● Record WebM'}
                      </button>
                    </div>
                  </div>
                </Section>

                {active.animations.length > 0 && (
                  <Section
                    title="Animation"
                    actions={
                      upperTracks.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            for (const t of upperTracks) {
                              send({ type: 'clearTrack', track: t.track, mixDuration });
                            }
                          }}
                          className={ghostBtnClass}
                        >
                          Clear layers ({upperTracks.length})
                        </button>
                      ) : null
                    }
                  >
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => patchItem(active.id, { playing: !playing })}
                          className="bg-accent2 text-bg px-3 py-1.5 rounded-lg text-[12px] font-semibold hover:brightness-110 w-[74px] flex-shrink-0"
                        >
                          {playing ? '❚❚ Pause' : '▶ Play'}
                        </button>
                        <select
                          value={track0Anim && track0Anim !== '(empty)' ? track0Anim : ''}
                          onChange={(e) => playOnTrack0(e.target.value)}
                          className="bg-bg border border-border rounded-lg px-2 py-1.5 text-[12px] flex-1 min-w-0"
                        >
                          <option value="">(Setup pose)</option>
                          {active.animations.map((a) => (
                            <option key={a.name} value={a.name}>
                              {a.name} ({formatTime(a.duration)})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setLoop((v) => !v)}
                          className={`flex-shrink-0 ${toggleClass(loop)}`}
                        >
                          Loop
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        {SPEEDS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setSpeed(s)}
                            className={`flex-1 ${toggleClass(speed === s)}`}
                          >
                            {s}×
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted tabular-nums w-[46px]">
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
                            setSeekRequest({ itemId: active.id, time, nonce: Date.now() });
                          }}
                          disabled={!playhead.duration}
                          className="flex-1 min-w-0 accent-accent2"
                        />
                        <span className="text-[11px] text-muted tabular-nums w-[46px] text-right">
                          {formatTime(playhead.duration)}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <label className="flex items-center gap-1.5 text-[11.5px] text-muted flex-1 min-w-0">
                          <span className="flex-shrink-0">Mix</span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={mixDuration}
                            onChange={(e) => setMixDuration(Number(e.target.value))}
                            className="flex-1 min-w-0 accent-accent2"
                          />
                          <span className="tabular-nums w-[34px] text-right flex-shrink-0">
                            {mixDuration.toFixed(2)}s
                          </span>
                        </label>
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) addToTrack(e.target.value);
                          }}
                          className="bg-bg border border-border rounded-lg px-2 py-1 text-[11.5px] text-muted hover:text-text max-w-[125px]"
                          title="Layer an animation on an upper track"
                        >
                          <option value="">+ Layer track…</option>
                          {active.animations.map((a) => (
                            <option key={a.name} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {upperTracks.length > 0 && (
                        <div className="flex flex-col gap-1 pt-1">
                          {tracks.map((t) => (
                            <div
                              key={t.track}
                              className="flex items-center gap-2 text-[11.5px] bg-bg border border-border rounded-lg px-2.5 py-1.5"
                            >
                              <span className="text-muted flex-shrink-0">T{t.track}</span>
                              <span className="flex-1 min-w-0 truncate font-medium" title={t.name}>
                                {t.name}
                              </span>
                              <span className="text-muted tabular-nums flex-shrink-0">
                                {formatTime(t.time)} / {formatTime(t.duration)}
                              </span>
                              {t.track > 0 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    send({ type: 'clearTrack', track: t.track, mixDuration })
                                  }
                                  className="px-1.5 py-0.5 rounded border border-border text-[10.5px] text-muted hover:text-text"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Section>
                )}

                {active.skins.length > 1 && (
                  <Section
                    title="Skins"
                    actions={
                      customSkins.length > 0 ? (
                        <button
                          type="button"
                          onClick={applyCombinedSkins}
                          className="bg-accent2 text-bg px-2.5 py-1 rounded-lg text-[11.5px] font-semibold hover:brightness-110"
                        >
                          Apply ({customSkins.length})
                        </button>
                      ) : null
                    }
                  >
                    <div className="flex flex-col gap-2">
                      <select
                        value={skinName}
                        onChange={(e) => selectSingleSkin(e.target.value)}
                        className="bg-bg border border-border rounded-lg px-2 py-1.5 text-[12px] w-full"
                      >
                        {skinName === '' && <option value="">(Combined skin)</option>}
                        {active.skins.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted mr-0.5">Combine:</span>
                        {active.skins.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => toggleCombinedSkin(name)}
                            className={toggleClass(customSkins.includes(name))}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </Section>
                )}

                <Section
                  title="Skeleton Specifications"
                  actions={
                    stats ? (
                      <div className="flex items-center gap-1.5">
                        {hiddenSlots.length > 0 && (
                          <button
                            type="button"
                            onClick={() => patchItem(active.id, { hiddenSlots: [] })}
                            className={ghostBtnClass}
                          >
                            Show all ({hiddenSlots.length})
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
                    <div className="text-[12.5px] text-muted">Inspecting skeleton…</div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="grid grid-cols-2 gap-2">
                        <StatCard
                          label="Bones"
                          value={formatNumber(stats.bones)}
                          sub={describeConstraints(stats)}
                        />
                        <StatCard
                          label="Slots & Batching"
                          value={`${formatNumber(stats.slots)} slots`}
                          sub={`${formatNumber(stats.drawCalls)} draw call${
                            stats.drawCalls === 1 ? '' : 's'
                          } · ${formatNumber(stats.totalAttachments)} att`}
                        />
                        <StatCard
                          label="Pose Geometry"
                          value={`${formatNumber(stats.vertices)} verts`}
                          sub={`${formatNumber(stats.triangles)} tris · ${
                            stats.meshAttachments
                              ? `${stats.meshAttachments} mesh`
                              : `${stats.regionAttachments} regions`
                          }`}
                        />
                        <StatCard
                          label="Skins & Anims"
                          value={`${formatNumber(stats.skins)} skin${stats.skins === 1 ? '' : 's'}`}
                          sub={`${formatNumber(stats.animations)} anim${
                            stats.animations === 1 ? '' : 's'
                          } · ${formatNumber(stats.events)} event${stats.events === 1 ? '' : 's'}`}
                        />
                        <StatCard
                          label="Dimensions (W×H)"
                          value={
                            stats.bounds
                              ? `${formatCoord(stats.bounds.width)} × ${formatCoord(stats.bounds.height)}`
                              : '—'
                          }
                          sub={
                            stats.setupSize
                              ? `Setup ${formatCoord(stats.setupSize.width)} × ${formatCoord(stats.setupSize.height)}`
                              : `${stats.fps || 30} FPS`
                          }
                        />
                        <StatCard
                          label="Atlas Pages"
                          value={`${formatNumber(stats.pages)} page${stats.pages === 1 ? '' : 's'}`}
                          sub={`${formatNumber(stats.regions)} regions · ${
                            effectivePma ? 'PMA' : 'Straight α'
                          }`}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <Chip accent>
                          {active.format} · Spine {active.version} ·{' '}
                          {formatBytes(active.totalBytes || active.size)}
                        </Chip>
                        <Chip>Runtime {runtimeLabelForKey(active.runtimeKey)}</Chip>
                        {stats.fps > 0 && <Chip>{stats.fps} FPS</Chip>}
                        {stats.bounds && (
                          <Chip
                            title={`Bounds origin (${formatCoord(stats.bounds.x)}, ${formatCoord(stats.bounds.y)})`}
                          >
                            Origin ({formatCoord(stats.bounds.x)}, {formatCoord(stats.bounds.y)})
                          </Chip>
                        )}
                        {stats.blendSlotCount > 0 && (
                          <Chip>{stats.blendSlotCount} non-normal blend</Chip>
                        )}
                        {stats.clippingAttachments > 0 && (
                          <Chip>{stats.clippingAttachments} clipping</Chip>
                        )}
                        {stats.weightedMeshes > 0 && (
                          <Chip>{stats.weightedMeshes} weighted mesh</Chip>
                        )}
                        {stats.hash && <Chip title={`Hash: ${stats.hash}`}>#{stats.hash}</Chip>}
                      </div>

                      <div className="grid grid-cols-3 gap-1.5 pt-2.5 border-t border-border">
                        {[
                          ['slots', `Slots (${stats.slotList?.length || 0})`],
                          ['bones', `Bones (${stats.boneList?.length || 0})`],
                          ['skins', `Skins (${stats.skinList?.length || 0})`],
                          ['atlas', `Atlas (${stats.pageList?.length || 0})`],
                          ['anims', `Anims (${stats.animList?.length || 0})`],
                          ['events', `Events (${stats.eventList?.length || 0})`],
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

                      {inspectorTab === 'slots' && (
                        <SlotList
                          slots={stats.slotList || []}
                          hiddenSlots={hiddenSlots}
                          onToggleSlot={toggleSlotVisibility}
                        />
                      )}
                      {inspectorTab === 'bones' && <BoneList bones={stats.boneList || []} />}
                      {inspectorTab === 'skins' && (
                        <SkinList
                          skins={stats.skinList || []}
                          activeSkin={skinName}
                          customSkins={customSkins}
                          onSelect={selectSingleSkin}
                          onToggleMix={toggleCombinedSkin}
                          onApplyMix={applyCombinedSkins}
                        />
                      )}
                      {inspectorTab === 'atlas' && <AtlasPageList pages={stats.pageList || []} />}
                      {inspectorTab === 'anims' && (
                        <AnimList
                          anims={stats.animList || []}
                          activeName={track0Anim}
                          onPlay={playOnTrack0}
                          onLayer={addToTrack}
                        />
                      )}
                      {inspectorTab === 'events' && <EventList events={stats.eventList || []} />}
                    </div>
                  )}
                </Section>
              </aside>
            </div>
          </div>
        )}
        <Toast toast={toast} />
      </ContentPane>
    </>
  );
}

function describeConstraints(stats) {
  const parts = [];
  if (stats.ikConstraints) parts.push(`${stats.ikConstraints} IK`);
  if (stats.transformConstraints) parts.push(`${stats.transformConstraints} xform`);
  if (stats.pathConstraints) parts.push(`${stats.pathConstraints} path`);
  if (stats.physicsConstraints) parts.push(`${stats.physicsConstraints} physics`);
  if (!parts.length) return `Max depth ${stats.maxBoneDepth ?? 0}`;
  return parts.join(' · ');
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted truncate">{label}</div>
      <div
        className="text-[13px] font-semibold text-text tabular-nums truncate mt-0.5"
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
      className={`px-2 py-0.5 rounded-md border max-w-full truncate ${
        accent
          ? 'bg-accent2/15 border-accent2/30 text-accent2 font-medium'
          : 'bg-bg border-border text-muted'
      }`}
    >
      {children}
    </span>
  );
}

function SlotList({ slots, hiddenSlots, onToggleSlot }) {
  if (!slots.length) {
    return <div className="text-[12px] text-muted">No slots in this skeleton.</div>;
  }
  return (
    <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
      {slots.map((s) => {
        const hidden = hiddenSlots.includes(s.name);
        return (
          <div
            key={`${s.index}-${s.name}`}
            className={`px-2.5 py-2 flex flex-col gap-1 ${hidden ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => onToggleSlot(s.name)}
                title={hidden ? 'Show slot' : 'Hide slot'}
                className={`px-1.5 py-0.5 rounded border text-[10.5px] flex-shrink-0 ${
                  hidden
                    ? 'border-border text-muted hover:text-text'
                    : 'border-accent2/40 bg-accent2/15 text-accent2'
                }`}
              >
                {hidden ? 'Off' : 'On'}
              </button>
              {s.color && s.color !== '#ffffff' && (
                <span
                  className="w-3 h-3 rounded border border-border flex-shrink-0"
                  style={{ backgroundColor: s.color }}
                  title={`Tint ${s.color} (α ${s.alpha})`}
                />
              )}
              <span className="text-[12.5px] font-medium truncate flex-1 min-w-0" title={s.name}>
                {s.name}
              </span>
              <span className="text-[11px] text-muted tabular-nums flex-shrink-0">
                {s.vertices ? `${formatNumber(s.vertices)}v` : '—'}
                {s.triangles ? ` · ${formatNumber(s.triangles)}t` : ''}
              </span>
            </div>
            <div className="text-[11px] text-muted truncate">
              {[
                s.attachmentType,
                s.attachmentName && s.attachmentName !== s.name ? `“${s.attachmentName}”` : null,
                `bone: ${s.bone}`,
                s.blendMode !== 'Normal' ? s.blendMode : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoneList({ bones }) {
  if (!bones.length) {
    return <div className="text-[12px] text-muted">No bones in this skeleton.</div>;
  }
  return (
    <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
      {bones.map((b) => (
        <div key={`${b.index}-${b.name}`} className="px-2.5 py-2 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[12.5px] font-medium truncate flex-1 min-w-0" title={b.name}>
              {b.depth > 0 ? (
                <span className="text-muted font-mono mr-1">
                  {'·'.repeat(Math.min(b.depth, 6))}
                </span>
              ) : null}
              {b.name}
            </span>
            <span className="text-[11px] text-muted tabular-nums flex-shrink-0">
              {b.length ? `len ${formatCoord(b.length)}` : 'point'}
            </span>
          </div>
          <div className="text-[11px] text-muted truncate tabular-nums">
            {[
              b.parent ? `parent: ${b.parent}` : 'root',
              `(${formatCoord(b.x)}, ${formatCoord(b.y)})`,
              b.rotation ? `${formatCoord(b.rotation)}°` : null,
              b.skinRequired ? 'skin-only' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ))}
    </div>
  );
}

function SkinList({ skins, activeSkin, customSkins, onSelect, onToggleMix, onApplyMix }) {
  if (!skins.length) {
    return <div className="text-[12px] text-muted">No skins defined.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {customSkins.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-bg border border-border text-[11.5px]">
          <span className="text-muted truncate">
            Selected mix: <span className="text-text">{customSkins.join(' + ')}</span>
          </span>
          <button
            type="button"
            onClick={onApplyMix}
            className="bg-accent2 text-bg px-2 py-0.5 rounded text-[11px] font-semibold hover:brightness-110 flex-shrink-0"
          >
            Apply mix
          </button>
        </div>
      )}
      <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
        {skins.map((s) => {
          const isCurrent = activeSkin === s.name && customSkins.length === 0;
          const inMix = customSkins.includes(s.name);
          return (
            <div
              key={s.name}
              className={`px-2.5 py-2 flex items-center justify-between gap-2 ${
                isCurrent ? 'bg-accent2/[0.08]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium truncate" title={s.name}>
                  {s.name}
                </div>
                <div className="text-[11px] text-muted tabular-nums truncate">
                  {[
                    `${formatNumber(s.attachments)} att`,
                    s.meshes ? `${s.meshes} mesh` : null,
                    s.bones ? `${s.bones} bones` : null,
                    s.constraints ? `${s.constraints} constr` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {skins.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onToggleMix(s.name)}
                    className={`px-2 py-0.5 rounded border text-[11px] ${
                      inMix
                        ? 'border-accent2/40 bg-accent2/15 text-accent2'
                        : 'border-border text-muted hover:text-text'
                    }`}
                    title="Include in combined skin"
                  >
                    {inMix ? 'Mixed' : '+ Mix'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onSelect(s.name)}
                  className={`px-2 py-0.5 rounded border text-[11px] ${
                    isCurrent
                      ? 'border-accent2/40 bg-accent2/15 text-accent2'
                      : 'border-border text-muted hover:text-text'
                  }`}
                >
                  {isCurrent ? 'Active' : 'Use'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AtlasPageList({ pages }) {
  if (!pages.length) {
    return <div className="text-[12px] text-muted">No atlas texture pages.</div>;
  }
  return (
    <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
      {pages.map((p, i) => (
        <div key={`${p.name}-${i}`} className="px-2.5 py-2 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[12.5px] font-medium truncate flex-1 min-w-0" title={p.name}>
              {p.name}
            </span>
            <span className="text-[11px] text-text tabular-nums flex-shrink-0">
              {p.width && p.height ? `${p.width} × ${p.height}` : '—'}
            </span>
          </div>
          <div className="text-[11px] text-muted truncate">
            {[
              `${formatNumber(p.regions)} regions`,
              p.sizeBytes ? formatBytes(p.sizeBytes) : null,
              p.filter,
              p.pma ? 'PMA' : 'Straight α',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ))}
    </div>
  );
}

function AnimList({ anims, activeName, onPlay, onLayer }) {
  if (!anims.length) {
    return <div className="text-[12px] text-muted">No animations in this skeleton.</div>;
  }
  return (
    <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
      {anims.map((a) => {
        const isCurrent = a.name === activeName;
        return (
          <div
            key={a.name}
            className={`px-2.5 py-2 flex items-center justify-between gap-2 ${
              isCurrent ? 'bg-accent2/[0.08]' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium truncate" title={a.name}>
                {a.name}
              </div>
              <div className="text-[11px] text-muted tabular-nums truncate">
                {[
                  formatTime(a.duration),
                  `${formatNumber(a.timelines)} timelines`,
                  `${formatNumber(a.keyframes)} keys`,
                  a.events.length ? `⚡ ${a.events.join(', ')}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => onLayer(a.name)}
                title="Add on a new upper track"
                className="px-2 py-0.5 rounded border border-border text-[11px] text-muted hover:text-text"
              >
                + Track
              </button>
              <button
                type="button"
                onClick={() => onPlay(a.name)}
                className={`px-2 py-0.5 rounded border text-[11px] ${
                  isCurrent
                    ? 'border-accent2/40 bg-accent2/15 text-accent2'
                    : 'border-border text-muted hover:text-text'
                }`}
              >
                {isCurrent ? 'Active' : 'Play'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventList({ events }) {
  if (!events.length) {
    return <div className="text-[12px] text-muted">No events defined in this skeleton.</div>;
  }
  return (
    <div className="border border-border rounded-lg bg-bg divide-y divide-border/60">
      {events.map((ev) => (
        <div key={ev.name} className="px-2.5 py-2 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span
              className="text-[12.5px] font-medium font-mono truncate flex-1 min-w-0"
              title={ev.name}
            >
              ⚡ {ev.name}
            </span>
            <span className="text-[11px] text-muted tabular-nums flex-shrink-0">
              {ev.usedIn.length
                ? `${ev.usedIn.length} anim${ev.usedIn.length === 1 ? '' : 's'}`
                : 'unused'}
            </span>
          </div>
          <div className="text-[11px] text-muted truncate">
            {[
              ev.intValue ? `int: ${ev.intValue}` : null,
              ev.floatValue ? `float: ${ev.floatValue}` : null,
              ev.stringValue ? `“${ev.stringValue}”` : null,
              ev.audioPath ? `audio: ${ev.audioPath}` : null,
              ev.usedIn.length ? `in: ${ev.usedIn.join(', ')}` : 'no timeline keys',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ))}
    </div>
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
