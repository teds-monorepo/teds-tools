'use client';

import { useEffect, useRef, useState } from 'react';
import { createSkeleton, loadRuntime, withHiddenSlots } from './runtime';

/**
 * The only WebGL surface of the Spine Viewer. Owns a single WebGL context,
 * render loop, per-skeleton instance cache, world grid/origin guides, camera
 * pan/zoom and PNG/WebM capture. The page drives playback/tracks/skins through
 * props + `command` and reads metadata back via callbacks.
 */
export default function SpineViewport({
  item,
  openIds = [],
  playing,
  speed,
  flipX = false,
  flipY = false,
  hiddenSlots = [],
  showGrid = true,
  showAxes = false,
  debug,
  premultipliedAlpha,
  bg,
  seekRequest,
  resetSignal,
  command,
  recording,
  snapshotSignal,
  onFilesDrop,
  onLoaded,
  onTime,
  onTracks,
  onSnapshot,
  onRecorded,
  onError,
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [firedEvent, setFiredEvent] = useState(null);
  const eventTimerRef = useRef(null);

  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const flipRef = useRef({ flipX, flipY });
  const hiddenSetRef = useRef(new Set(hiddenSlots));
  const guidesRef = useRef({ showGrid, showAxes });
  const debugRef = useRef(debug);
  const pmaRef = useRef(premultipliedAlpha);
  const bgRef = useRef(bg);
  const callbacksRef = useRef(null);

  playingRef.current = playing;
  speedRef.current = speed;
  flipRef.current = { flipX, flipY };
  hiddenSetRef.current = new Set(hiddenSlots || []);
  guidesRef.current = { showGrid, showAxes };
  debugRef.current = debug;
  pmaRef.current = premultipliedAlpha;
  bgRef.current = bg;
  callbacksRef.current = { onLoaded, onTime, onTracks, onSnapshot, onRecorded, onError };

  // ── Single WebGL context & continuous render loop (mount lifetime) ───
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctxConfig = { alpha: true, preserveDrawingBuffer: true, antialias: true };
    const gl = canvas.getContext('webgl2', ctxConfig) || canvas.getContext('webgl', ctxConfig);
    if (!gl) {
      callbacksRef.current?.onError?.('WebGL is not available in this browser.');
      return undefined;
    }

    const st = {
      canvas,
      gl,
      /** id -> { id, spine, context, renderer, handle, cam, fit, colors, lastTracksKey, lastTimeKey, reported } */
      cache: new Map(),
      activeEntry: null,
      activeId: null,
      disposed: false,
    };
    stateRef.current = st;

    const onContextLost = (e) => e.preventDefault();
    const onContextRestored = () => {
      for (const entry of st.cache.values()) {
        const list = entry.context?.restorables || [];
        for (let i = 0; i < list.length; i++) list[i].restore?.();
      }
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      if (st.disposed) return;
      raf = requestAnimationFrame(frame);
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;

      const entry = st.activeEntry;
      const [r, g, b] = hexToRgb(bgRef.current);
      if (!entry) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      const { spine, renderer, handle, cam } = entry;
      renderer.resize(spine.ResizeMode.Stretch);
      const clientW = Math.max(canvas.clientWidth, 1);
      const clientH = Math.max(canvas.clientHeight, 1);
      const aspect = clientW / clientH;
      const vw = cam.worldHeight * aspect;
      const vh = cam.worldHeight;
      renderer.camera.setViewport(vw, vh);
      renderer.camera.position.x = cam.cx;
      renderer.camera.position.y = cam.cy;
      renderer.camera.update();

      const { flipX: fx, flipY: fy } = flipRef.current;
      const wantScaleX = fx ? -1 : 1;
      const wantScaleY = fy ? -1 : 1;
      if (handle.skeleton.scaleX !== wantScaleX || handle.skeleton.scaleY !== wantScaleY) {
        handle.skeleton.scaleX = wantScaleX;
        handle.skeleton.scaleY = wantScaleY;
      }

      if (playingRef.current) {
        handle.state.update(delta * speedRef.current);
      }
      handle.state.apply(handle.skeleton);
      handle.updateWorldTransform();

      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const isLightBg = r * 0.299 + g * 0.587 + b * 0.114 > 0.6;
      const { showGrid: gridOn, showAxes: axesOn } = guidesRef.current;
      const d = debugRef.current || {};
      const pma = pmaRef.current ?? handle.defaultPma;
      const hiddenSet = hiddenSetRef.current;

      renderer.begin();
      if (gridOn || axesOn) {
        drawWorldGuides(renderer, entry.colors, cam, vw, vh, gridOn, axesOn, isLightBg);
      }

      withHiddenSlots(handle.skeleton, hiddenSet, () => {
        renderer.drawSkeleton(handle.skeleton, pma);
        const anyDebug =
          d.bones ||
          d.regionAttachments ||
          d.boundingBoxes ||
          d.meshTriangles ||
          d.paths ||
          d.clipping;
        if (anyDebug) {
          const dr = renderer.skeletonDebugRenderer;
          dr.scale = vh / clientH;
          dr.drawBones = !!d.bones;
          dr.drawSkeletonXY = !!d.bones;
          dr.drawRegionAttachments = !!d.regionAttachments;
          dr.drawBoundingBoxes = !!d.boundingBoxes;
          dr.drawMeshHull = !!d.meshTriangles;
          dr.drawMeshTriangles = !!d.meshTriangles;
          dr.drawPaths = !!d.paths;
          dr.drawClipping = !!d.clipping;
          renderer.drawSkeletonDebug(handle.skeleton, pma);
          if (d.boundingBoxes) {
            const box = handle.bounds(null);
            if (box && !box.fallback) {
              const x2 = box.x + box.width;
              const y2 = box.y + box.height;
              const c = entry.colors.bounds;
              renderer.line(box.x, box.y, x2, box.y, c);
              renderer.line(x2, box.y, x2, y2, c);
              renderer.line(x2, y2, box.x, y2, c);
              renderer.line(box.x, y2, box.x, box.y, c);
            }
          }
        }
      });
      renderer.end();

      emitTrackAndTime(entry, callbacksRef.current);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      st.disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(eventTimerRef.current);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      for (const entry of st.cache.values()) disposeEntry(entry);
      st.cache.clear();
      st.activeEntry = null;
      stateRef.current = null;
    };
  }, []);

  // ── Release closed skeletons from GPU cache ──────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const keep = new Set(openIds);
    for (const [id, entry] of st.cache.entries()) {
      if (!keep.has(id)) {
        if (st.activeEntry === entry) st.activeEntry = null;
        disposeEntry(entry);
        st.cache.delete(id);
      }
    }
  }, [openIds]);

  // ── Load or swap active skeleton ─────────────────────────────────────
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return undefined;
    setFiredEvent(null);

    if (!item) {
      st.activeId = null;
      st.activeEntry = null;
      return undefined;
    }
    st.activeId = item.id;

    const cached = st.cache.get(item.id);
    if (cached) {
      st.activeEntry = cached;
      cached.lastTracksKey = '';
      cached.lastTimeKey = '';
      emitTrackAndTime(cached, callbacksRef.current);
      return undefined;
    }

    let cancelled = false;
    st.activeEntry = null;
    const loadId = item.id;

    (async () => {
      try {
        const spine = await loadRuntime(item.runtimeKey);
        if (cancelled || st.disposed) return;

        const context = new spine.ManagedWebGLRenderingContext(st.gl);
        const handle = await createSkeleton(spine, context, item);
        if (cancelled || st.disposed) {
          handle.dispose();
          return;
        }

        const renderer = new spine.SceneRenderer(st.canvas, context);
        const cam = { cx: 0, cy: 0, worldHeight: 200 };
        const fit = (mode = 'fit') => {
          const clientW = Math.max(st.canvas.clientWidth, 1);
          const clientH = Math.max(st.canvas.clientHeight, 1);
          const aspect = clientW / clientH;
          if (mode === '1:1') {
            const b = handle.bounds(hiddenSetRef.current);
            cam.cx = b.x + b.width / 2;
            cam.cy = b.y + b.height / 2;
            cam.worldHeight = clientH;
            return;
          }
          if (mode === 'origin') {
            const b = handle.bounds(hiddenSetRef.current);
            const reachY = Math.max(Math.abs(b.y), Math.abs(b.y + b.height), b.height * 0.6, 50);
            const reachX = Math.max(Math.abs(b.x), Math.abs(b.x + b.width), b.width * 0.6, 50);
            let vh = reachY * 2.3;
            if (vh * aspect < reachX * 2.3) vh = (reachX * 2.3) / aspect;
            cam.cx = 0;
            cam.cy = Math.max(0, b.y + b.height * 0.35);
            cam.worldHeight = Math.max(vh, 1);
            return;
          }
          const b = handle.bounds(hiddenSetRef.current);
          let vh = Math.max(b.height * 1.2, 1);
          let vw = vh * aspect;
          if (vw < b.width * 1.2) {
            vw = Math.max(b.width * 1.2, 1);
            vh = vw / aspect;
          }
          cam.cx = b.x + b.width / 2;
          cam.cy = b.y + b.height / 2;
          cam.worldHeight = vh;
        };

        if (handle.animations.length) {
          handle.state.setAnimation(0, handle.animations[0].name, true);
          handle.state.update(0);
          handle.state.apply(handle.skeleton);
          handle.updateWorldTransform();
        }

        handle.state.addListener({
          event(trackEntry, ev) {
            if (st.activeId !== loadId || !ev?.data?.name) return;
            const t = trackEntry?.getAnimationTime
              ? trackEntry.getAnimationTime()
              : trackEntry?.trackTime || 0;
            clearTimeout(eventTimerRef.current);
            setFiredEvent({ name: ev.data.name, time: t });
            eventTimerRef.current = setTimeout(() => setFiredEvent(null), 1400);
          },
        });

        const stats = handle.inspect(hiddenSetRef.current);
        fit('fit');

        const entry = {
          id: loadId,
          spine,
          context,
          renderer,
          handle,
          cam,
          fit,
          colors: buildGuideColors(spine),
          lastTracksKey: '',
          lastTimeKey: '',
        };
        st.cache.set(loadId, entry);
        if (st.activeId === loadId) {
          st.activeEntry = entry;
        }
        callbacksRef.current.onLoaded?.(loadId, {
          animations: handle.animations,
          skins: handle.skins,
          initialSkin: handle.initialSkin,
          defaultPma: handle.defaultPma,
          stats,
        });
        emitTrackAndTime(entry, callbacksRef.current);
      } catch (err) {
        if (!cancelled) callbacksRef.current.onError?.(err?.message || String(err), loadId);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  // ── Commands from the page ───────────────────────────────────────────
  const lastCommandNonceRef = useRef(null);
  useEffect(() => {
    const entry = stateRef.current?.activeEntry;
    if (!entry || !command || command.nonce === lastCommandNonceRef.current) return;
    if (command.itemId && command.itemId !== entry.id) return;
    lastCommandNonceRef.current = command.nonce;
    const { handle } = entry;
    try {
      if (command.type === 'setTrack') {
        if (command.mixFrom && command.mixDuration != null) {
          handle.stateData.setMix(command.mixFrom, command.name, command.mixDuration);
        }
        handle.state.setAnimation(command.track, command.name, command.loop);
        handle.state.apply(handle.skeleton);
        handle.updateWorldTransform();
        if (command.track === 0) {
          callbacksRef.current.onLoaded?.(entry.id, {
            animations: handle.animations,
            skins: handle.skins,
            initialSkin: handle.initialSkin,
            defaultPma: handle.defaultPma,
            stats: handle.inspect(hiddenSetRef.current),
          });
        }
      } else if (command.type === 'clearTrack') {
        handle.state.setEmptyAnimation(command.track, command.mixDuration ?? 0.2);
      } else if (command.type === 'clearTracks') {
        handle.resetToSetupPose();
        callbacksRef.current.onLoaded?.(entry.id, {
          animations: handle.animations,
          skins: handle.skins,
          initialSkin: handle.initialSkin,
          defaultPma: handle.defaultPma,
          stats: handle.inspect(hiddenSetRef.current),
        });
      } else if (command.type === 'setSkin') {
        handle.setSkin(command.name);
        callbacksRef.current.onLoaded?.(entry.id, {
          animations: handle.animations,
          skins: handle.skins,
          initialSkin: handle.initialSkin,
          defaultPma: handle.defaultPma,
          stats: handle.inspect(hiddenSetRef.current),
        });
      } else if (command.type === 'customSkin') {
        handle.setCustomSkin(command.names);
        callbacksRef.current.onLoaded?.(entry.id, {
          animations: handle.animations,
          skins: handle.skins,
          initialSkin: handle.initialSkin,
          defaultPma: handle.defaultPma,
          stats: handle.inspect(hiddenSetRef.current),
        });
      }
      entry.lastTracksKey = '';
      entry.lastTimeKey = '';
      emitTrackAndTime(entry, callbacksRef.current);
    } catch (err) {
      callbacksRef.current.onError?.(err?.message || String(err), entry.id);
    }
  }, [command]);

  // ── Scrub & camera reset ─────────────────────────────────────────────
  useEffect(() => {
    const entry = stateRef.current?.activeEntry;
    if (!entry || !seekRequest) return;
    if (seekRequest.itemId && seekRequest.itemId !== entry.id) return;
    entry.handle.seek(seekRequest.time);
    entry.lastTimeKey = '';
    emitTrackAndTime(entry, callbacksRef.current);
  }, [seekRequest]);

  useEffect(() => {
    if (resetSignal) stateRef.current?.activeEntry?.fit('fit');
  }, [resetSignal]);

  // ── Export: PNG snapshot & WebM recording ────────────────────────────
  useEffect(() => {
    if (!snapshotSignal || !canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (blob) callbacksRef.current.onSnapshot?.(blob);
    }, 'image/png');
  }, [snapshotSignal]);

  const recorderRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || recording === undefined) return undefined;
    if (recording && !recorderRef.current) {
      const chunks = [];
      const mimeType = MediaRecorder.isTypeSupported?.('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        recorderRef.current = null;
        callbacksRef.current.onRecorded?.(new Blob(chunks, { type: 'video/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
    } else if (!recording && recorderRef.current) {
      recorderRef.current.stop();
    }
    return undefined;
  }, [recording]);

  // ── Camera input: cursor-centered wheel zoom, drag pan, dblclick fit ─
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let drag = null;
    const onWheel = (e) => {
      const entry = stateRef.current?.activeEntry;
      if (!entry) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
      const ny = 0.5 - (e.clientY - rect.top) / Math.max(rect.height, 1);
      const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
      const oldH = entry.cam.worldHeight;
      const newH = clamp(oldH * (e.deltaY > 0 ? 1.1 : 0.9), 1, 200000);
      entry.cam.cx += nx * (oldH - newH) * aspect;
      entry.cam.cy += ny * (oldH - newH);
      entry.cam.worldHeight = newH;
    };
    const onDown = (e) => {
      drag = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      const entry = stateRef.current?.activeEntry;
      if (!entry || !drag) return;
      const scale = entry.cam.worldHeight / Math.max(canvas.clientHeight, 1);
      entry.cam.cx -= (e.clientX - drag.x) * scale;
      entry.cam.cy += (e.clientY - drag.y) * scale;
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      drag = null;
    };
    const onDblClick = () => stateRef.current?.activeEntry?.fit('fit');

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

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
      <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" />

      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent2/10 border border-dashed border-accent2 rounded-lg pointer-events-none text-[13px] font-medium text-text">
          Drop Spine files or .zip to open
        </div>
      )}

      {(recording || firedEvent) && (
        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 pointer-events-none">
          {recording && (
            <span className="bg-panel/85 border border-red-400/40 text-red-400 px-2.5 py-1 rounded-lg text-[11px] font-medium backdrop-blur-sm">
              ● REC WebM
            </span>
          )}
          {firedEvent && (
            <span className="bg-panel/85 border border-accent2/40 text-accent2 px-2.5 py-1 rounded-lg text-[11px] font-mono backdrop-blur-sm">
              ⚡ {firedEvent.name} ({firedEvent.time.toFixed(2)}s)
            </span>
          )}
        </div>
      )}

      <div className="hidden sm:block absolute bottom-2.5 left-2.5 pointer-events-none bg-panel/75 border border-border/80 text-muted px-2.5 py-1 rounded-lg text-[11px] backdrop-blur-sm">
        Drag pan · Scroll zoom · Double-click fit
      </div>

      <div className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 bg-panel/85 border border-border p-0.5 rounded-lg backdrop-blur-sm">
        {[
          ['origin', 'Origin'],
          ['1:1', '1:1'],
          ['fit', '⤢ Fit'],
        ].map(([preset, label]) => (
          <button
            key={preset}
            type="button"
            title={`Camera: ${label}`}
            onClick={() => stateRef.current?.activeEntry?.fit(preset)}
            className="text-muted hover:text-text hover:bg-panel2 px-2 py-1 rounded-md text-[11.5px]"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function disposeEntry(entry) {
  if (!entry) return;
  entry.handle?.dispose?.();
  entry.renderer?.dispose?.();
}

function emitTrackAndTime(entry, cbs) {
  if (!entry || !cbs) return;
  const tracks = entry.handle.state.tracks
    .map((te, index) => (te ? { index, te } : null))
    .filter(Boolean)
    .map(({ index, te }) => ({
      track: index,
      name: te.animation?.name || '(empty)',
      // trackTime grows past the duration when looping; the playhead needs the wrapped time.
      time: te.getAnimationTime ? te.getAnimationTime() : te.trackTime || 0,
      duration: te.animation?.duration || 0,
      loop: !!te.loop,
    }));
  const key = tracks.map((t) => `${t.track}:${t.name}:${t.loop}`).join('|');
  if (key !== entry.lastTracksKey) {
    entry.lastTracksKey = key;
    cbs.onTracks?.(entry.id, tracks);
  }
  const t0 = tracks.find((t) => t.track === 0);
  const timeKey = `${Math.round((t0?.time || 0) * 20)}:${t0?.duration || 0}`;
  if (timeKey !== entry.lastTimeKey) {
    entry.lastTimeKey = timeKey;
    cbs.onTime?.(entry.id, t0?.time || 0, t0?.duration || 0);
  }
}

function buildGuideColors(spine) {
  return {
    minorDark: new spine.Color(0.145, 0.169, 0.271, 0.45),
    majorDark: new spine.Color(0.2, 0.24, 0.38, 0.75),
    minorLight: new spine.Color(0.12, 0.15, 0.25, 0.11),
    majorLight: new spine.Color(0.12, 0.15, 0.25, 0.22),
    ground: new spine.Color(0.243, 0.812, 0.557, 0.45),
    axisX: new spine.Color(0.973, 0.443, 0.443, 0.8),
    axisY: new spine.Color(0.243, 0.812, 0.557, 0.8),
    bounds: new spine.Color(0.424, 0.545, 1.0, 0.85),
  };
}

function niceGridStep(worldHeight) {
  const raw = Math.max(worldHeight / 8, 1e-4);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

function drawWorldGuides(renderer, colors, cam, vw, vh, showGrid, showAxes, isLightBg) {
  const minX = cam.cx - vw * 0.5;
  const maxX = cam.cx + vw * 0.5;
  const minY = cam.cy - vh * 0.5;
  const maxY = cam.cy + vh * 0.5;

  if (showGrid) {
    const step = niceGridStep(vh);
    const minor = isLightBg ? colors.minorLight : colors.minorDark;
    const major = isLightBg ? colors.majorLight : colors.majorDark;

    const iStartX = Math.floor(minX / step);
    const iEndX = Math.ceil(maxX / step);
    if (iEndX - iStartX <= 240) {
      for (let i = iStartX; i <= iEndX; i++) {
        if (i === 0 && showAxes) continue;
        const x = i * step;
        renderer.line(x, minY, x, maxY, i % 5 === 0 ? major : minor);
      }
    }

    const iStartY = Math.floor(minY / step);
    const iEndY = Math.ceil(maxY / step);
    if (iEndY - iStartY <= 240) {
      for (let i = iStartY; i <= iEndY; i++) {
        if (i === 0) {
          if (!showAxes) renderer.line(minX, 0, maxX, 0, colors.ground);
          continue;
        }
        const y = i * step;
        renderer.line(minX, y, maxX, y, i % 5 === 0 ? major : minor);
      }
    }
  }

  if (showAxes) {
    renderer.line(minX, 0, maxX, 0, colors.axisX);
    renderer.line(0, minY, 0, maxY, colors.axisY);
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function hexToRgb(hex) {
  const n = parseInt(String(hex || '#0b0e1a').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
