'use client';

import { useEffect, useRef } from 'react';
import { createSkeleton, loadRuntime } from './runtime';

/**
 * The only WebGL surface of the Spine Viewer. Loads the runtime matching the
 * item's Spine version, owns the render loop, camera and export capture; the
 * page drives playback/tracks/skins through `command` and reads state back
 * via onLoaded / onTime / onTracks.
 *
 * item: { id, runtimeKey, atlasText, pageUrls, skeletonText?, skeletonBytes? }
 * command: { nonce, type: 'setTrack'|'clearTrack'|'setSkin'|'customSkin', ... }
 */
export default function SpineViewport({
  item,
  playing,
  speed,
  seekRequest,
  resetSignal,
  command,
  debug,
  premultipliedAlpha,
  bg,
  recording,
  snapshotSignal,
  onLoaded,
  onTime,
  onTracks,
  onSnapshot,
  onRecorded,
  onError,
}) {
  const canvasRef = useRef(null);
  const liveRef = useRef(null);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const debugRef = useRef(debug);
  const pmaRef = useRef(premultipliedAlpha);
  const callbacksRef = useRef(null);
  playingRef.current = playing;
  speedRef.current = speed;
  debugRef.current = debug;
  pmaRef.current = premultipliedAlpha;
  callbacksRef.current = { onLoaded, onTime, onTracks, onSnapshot, onRecorded, onError };

  // ── Load + render loop (per item) ────────────────────────────────
  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    let raf = 0;
    const canvas = canvasRef.current;

    (async () => {
      try {
        const spine = await loadRuntime(item.runtimeKey);
        if (cancelled) return;
        const context = new spine.ManagedWebGLRenderingContext(canvas, {
          alpha: true,
          preserveDrawingBuffer: true,
        });
        const handle = await createSkeleton(spine, context, item);
        if (cancelled) {
          handle.dispose();
          return;
        }
        const renderer = new spine.SceneRenderer(canvas, context);
        const cam = { cx: 0, cy: 0, worldHeight: 100 };
        const fit = () => {
          const b = handle.bounds();
          const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
          let vh = Math.max(b.height * 1.15, 1);
          let vw = vh * aspect;
          if (vw < b.width * 1.15) {
            vw = Math.max(b.width * 1.15, 1);
            vh = vw / aspect;
          }
          cam.cx = b.x + b.width / 2;
          cam.cy = b.y + b.height / 2;
          cam.worldHeight = vh;
        };
        fit();

        const live = { spine, context, renderer, handle, cam, fit, lastTracksKey: '' };
        liveRef.current = live;
        callbacksRef.current.onLoaded(item.id, {
          animations: handle.animations,
          skins: handle.skins,
          defaultPma: handle.defaultPma,
        });
        if (handle.animations.length) {
          handle.state.setAnimation(0, handle.animations[0].name, true);
        }

        let last = performance.now();
        const frame = (now) => {
          if (cancelled) return;
          raf = requestAnimationFrame(frame);
          const delta = Math.min((now - last) / 1000, 0.1);
          last = now;
          renderer.resize(spine.ResizeMode.Stretch);
          const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
          renderer.camera.setViewport(cam.worldHeight * aspect, cam.worldHeight);
          renderer.camera.position.x = cam.cx;
          renderer.camera.position.y = cam.cy;
          renderer.camera.update();

          if (playingRef.current) {
            handle.state.update(delta * speedRef.current);
          }
          handle.state.apply(handle.skeleton);
          handle.updateWorldTransform();

          const gl = context.gl;
          const [r, g, b] = hexToRgb(bgRef.current);
          gl.clearColor(r, g, b, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          renderer.begin();
          const pma = pmaRef.current ?? handle.defaultPma;
          renderer.drawSkeleton(handle.skeleton, pma);
          const d = debugRef.current || {};
          if (d.bones || d.regionAttachments || d.boundingBoxes || d.meshTriangles) {
            const dr = renderer.skeletonDebugRenderer;
            dr.drawBones = !!d.bones;
            dr.drawRegionAttachments = !!d.regionAttachments;
            dr.drawBoundingBoxes = !!d.boundingBoxes;
            dr.drawMeshHull = !!d.meshTriangles;
            dr.drawMeshTriangles = !!d.meshTriangles;
            renderer.drawSkeletonDebug(handle.skeleton, pma);
          }
          renderer.end();

          const tracks = handle.state.tracks
            .map((entry, index) => (entry ? { index, entry } : null))
            .filter(Boolean)
            .map(({ index, entry }) => ({
              track: index,
              name: entry.animation?.name || '(empty)',
              time: entry.trackTime || 0,
              duration: entry.animation?.duration || 0,
              loop: !!entry.loop,
            }));
          const key = tracks.map((t) => `${t.track}:${t.name}:${t.loop}`).join('|');
          if (key !== live.lastTracksKey) {
            live.lastTracksKey = key;
            callbacksRef.current.onTracks(item.id, tracks);
          }
          const t0 = tracks.find((t) => t.track === 0);
          callbacksRef.current.onTime(item.id, t0?.time || 0, t0?.duration || 0);
        };
        raf = requestAnimationFrame(frame);
      } catch (err) {
        if (!cancelled) callbacksRef.current.onError(err?.message || String(err), item.id);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const live = liveRef.current;
      if (live) {
        live.handle.dispose();
        live.renderer.dispose?.();
        liveRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const bgRef = useRef(bg);
  bgRef.current = bg;

  // ── Commands from the page ───────────────────────────────────────
  useEffect(() => {
    const live = liveRef.current;
    if (!live || !command) return;
    const { handle } = live;
    try {
      if (command.type === 'setTrack') {
        if (command.mixFrom && command.mixDuration != null) {
          handle.stateData.setMix(command.mixFrom, command.name, command.mixDuration);
        }
        handle.state.setAnimation(command.track, command.name, command.loop);
      } else if (command.type === 'clearTrack') {
        handle.state.setEmptyAnimation(command.track, command.mixDuration ?? 0.2);
      } else if (command.type === 'setSkin') {
        handle.setSkin(command.name);
      } else if (command.type === 'customSkin') {
        handle.setCustomSkin(command.names);
      }
    } catch (err) {
      callbacksRef.current.onError(err?.message || String(err), item?.id);
    }
  }, [command, item?.id]);

  useEffect(() => {
    const live = liveRef.current;
    if (!live || !seekRequest) return;
    const entry = live.handle.state.tracks[0];
    if (entry) entry.trackTime = seekRequest.time;
  }, [seekRequest]);

  useEffect(() => {
    if (resetSignal) liveRef.current?.fit();
  }, [resetSignal]);

  // ── Export ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!snapshotSignal || !canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (blob) callbacksRef.current.onSnapshot(blob);
    }, 'image/png');
  }, [snapshotSignal]);

  const recorderRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || recording === undefined) return undefined;
    if (recording && !recorderRef.current) {
      const chunks = [];
      const recorder = new MediaRecorder(canvas.captureStream(30), {
        mimeType: 'video/webm',
      });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        recorderRef.current = null;
        callbacksRef.current.onRecorded(new Blob(chunks, { type: 'video/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
    } else if (!recording && recorderRef.current) {
      recorderRef.current.stop();
    }
    return undefined;
  }, [recording]);

  // ── Camera input: wheel zoom, drag pan ───────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let drag = null;
    const onWheel = (e) => {
      const live = liveRef.current;
      if (!live) return;
      e.preventDefault();
      live.cam.worldHeight = clamp(live.cam.worldHeight * (e.deltaY > 0 ? 1.1 : 0.9), 1, 100000);
    };
    const onDown = (e) => {
      drag = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      const live = liveRef.current;
      if (!live || !drag) return;
      const scale = live.cam.worldHeight / (canvas.clientHeight || 1);
      live.cam.cx -= (e.clientX - drag.x) * scale;
      live.cam.cy += (e.clientY - drag.y) * scale;
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => (drag = null);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full block cursor-grab" />;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function hexToRgb(hex) {
  const n = parseInt(String(hex || '#0b0e1a').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
