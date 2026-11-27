'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createZip, downloadBlob } from '@/lib/zip';
import {
  EXPAND_DIRECTIONS,
  FIT_MODES,
  clampDimension,
  computeSyncPlacement,
  maxDimensions,
  uniquePngNames,
} from '@/lib/syncsize';
import { DropZone, Section, Toast, useToast } from './Shared';

const numInputClass =
  'w-24 bg-bg border border-border text-text px-2 py-1 rounded-lg text-[12.5px]';
const ghostBtnClass =
  'bg-transparent border border-border text-muted hover:text-text px-2.5 py-1.5 rounded-lg text-[12.5px]';
const runBtnClass =
  'bg-accent2 text-bg px-3.5 py-2 rounded-lg text-[12.5px] font-semibold hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100';

const SIZE_PRESETS = [64, 128, 256, 512, 1024];

const CHECKER_STYLE = {
  backgroundColor: '#0b0e1a',
  backgroundImage:
    'linear-gradient(45deg, #171c33 25%, transparent 25%), linear-gradient(-45deg, #171c33 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #171c33 75%), linear-gradient(-45deg, transparent 75%, #171c33 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

const SMALL_CHECKER_STYLE = {
  ...CHECKER_STYLE,
  backgroundSize: '10px 10px',
  backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0',
};

const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode PNG'))),
      'image/png'
    )
  );

function SyncStage({
  asset,
  targetW,
  targetH,
  maxBoxW,
  maxBoxH,
  allowUpscale = false,
  direction,
  fitMode,
  fillBg,
  bgColor,
  pixelated,
  showBounds = false,
  smallChecker = false,
}) {
  const placement = computeSyncPlacement(asset.w, asset.h, targetW, targetH, direction, fitMode);

  let scale = Math.min(maxBoxW / targetW, maxBoxH / targetH);
  if (!allowUpscale) {
    scale = Math.min(1, scale);
  } else if (Math.max(targetW, targetH) < 160) {
    scale = Math.min(scale, 4, 192 / Math.max(targetW, targetH));
  } else {
    scale = Math.min(1, scale);
  }

  const dispW = Math.max(1, Math.round(targetW * scale));
  const dispH = Math.max(1, Math.round(targetH * scale));
  const crisp = pixelated || scale > 1;

  return (
    <div
      className="relative overflow-hidden border border-border flex-shrink-0"
      style={{
        width: dispW,
        height: dispH,
        ...(fillBg
          ? { backgroundColor: bgColor }
          : smallChecker
            ? SMALL_CHECKER_STYLE
            : CHECKER_STYLE),
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.url}
        alt={asset.name}
        draggable={false}
        className={`absolute max-w-none select-none pointer-events-none ${
          crisp ? '[image-rendering:pixelated]' : ''
        }`}
        style={{
          left: `${(placement.x / targetW) * 100}%`,
          top: `${(placement.y / targetH) * 100}%`,
          width: `${(placement.w / targetW) * 100}%`,
          height: `${(placement.h / targetH) * 100}%`,
        }}
      />
      {showBounds && (
        <div
          className="absolute border border-dashed border-accent2/60 pointer-events-none"
          style={{
            left: `${(placement.x / targetW) * 100}%`,
            top: `${(placement.y / targetH) * 100}%`,
            width: `${(placement.w / targetW) * 100}%`,
            height: `${(placement.h / targetH) * 100}%`,
          }}
        />
      )}
    </div>
  );
}

export default function SyncSize() {
  const { toast, show } = useToast();
  const [assets, setAssets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [width, setWidth] = useState(256);
  const [height, setHeight] = useState(256);
  const [inputW, setInputW] = useState('256');
  const [inputH, setInputH] = useState('256');

  const [direction, setDirection] = useState('center');
  const [fitMode, setFitMode] = useState('canvas');
  const [fillBg, setFillBg] = useState(false);
  const [bgColor, setBgColor] = useState('#000000');
  const [pixelated, setPixelated] = useState(false);
  const [showBounds, setShowBounds] = useState(true);
  const [viewMode, setViewMode] = useState('single');
  const [isExporting, setIsExporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const nextId = useRef(1);
  const sizeTouched = useRef(false);
  const assetsRef = useRef([]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(
    () => () => {
      assetsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    },
    []
  );

  const maxDim = useMemo(() => maxDimensions(assets), [assets]);
  const activeDir = EXPAND_DIRECTIONS.find((d) => d.id === direction) || EXPAND_DIRECTIONS[4];
  const activeFit = FIT_MODES.find((m) => m.id === fitMode) || FIT_MODES[0];

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedId) || assets[0] || null,
    [assets, selectedId]
  );

  const selectedPlacement = useMemo(() => {
    if (!selectedAsset) return null;
    return computeSyncPlacement(
      selectedAsset.w,
      selectedAsset.h,
      width,
      height,
      direction,
      fitMode
    );
  }, [selectedAsset, width, height, direction, fitMode]);

  function applyDimensions(nextW, nextH, markTouched = true) {
    const w = clampDimension(nextW, width);
    const h = clampDimension(nextH, height);
    if (markTouched) sizeTouched.current = true;
    setWidth(w);
    setHeight(h);
    setInputW(String(w));
    setInputH(String(h));
  }

  function handleWidthChange(raw) {
    setInputW(raw);
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      sizeTouched.current = true;
      setWidth(clampDimension(parsed));
    }
  }

  function handleHeightChange(raw) {
    setInputH(raw);
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      sizeTouched.current = true;
      setHeight(clampDimension(parsed));
    }
  }

  function commitWidth() {
    const w = clampDimension(inputW, width);
    setWidth(w);
    setInputW(String(w));
  }

  function commitHeight() {
    const h = clampDimension(inputH, height);
    setHeight(h);
    setInputH(String(h));
  }

  function addFiles(files) {
    const imageFiles = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) {
      show('No image files found', 'error');
      return;
    }

    const loaded = [];
    let pending = imageFiles.length;

    const settle = () => {
      if (--pending === 0 && loaded.length > 0) {
        setAssets((prev) => {
          const combined = [...prev, ...loaded];
          if (!sizeTouched.current) {
            const m = maxDimensions(combined);
            setWidth(m.w);
            setHeight(m.h);
            setInputW(String(m.w));
            setInputH(String(m.h));
          }
          return combined;
        });
        setSelectedId((prev) => prev ?? loaded[0].id);
      }
    };

    for (const file of imageFiles) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        loaded.push({
          id: nextId.current++,
          name: file.name.replace(/\.[^/.]+$/, ''),
          img,
          w: img.naturalWidth,
          h: img.naturalHeight,
          url,
        });
        settle();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        settle();
      };
      img.src = url;
    }
  }

  function removeAsset(id) {
    setAssets((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const next = prev.filter((a) => a.id !== id);
      if (next.length === 0) {
        sizeTouched.current = false;
        setSelectedId(null);
      } else if (selectedId === id) {
        setSelectedId(next[0].id);
      }
      return next;
    });
  }

  function clearAll() {
    setAssets((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.url));
      return [];
    });
    setSelectedId(null);
    sizeTouched.current = false;
  }

  async function handleExport() {
    if (!assets.length) return;
    setIsExporting(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const fileNames = uniquePngNames(assets.map((a) => a.name));
      const entries = [];

      for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        ctx.clearRect(0, 0, width, height);
        if (fillBg) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);
        }
        ctx.imageSmoothingEnabled = !pixelated;
        if (!pixelated) ctx.imageSmoothingQuality = 'high';

        const rect = computeSyncPlacement(a.w, a.h, width, height, direction, fitMode);
        ctx.drawImage(a.img, rect.x, rect.y, rect.w, rect.h);
        entries.push({ name: fileNames[i], data: await canvasToBlob(canvas) });
      }

      const zip = await createZip(entries);
      downloadBlob(zip, `sync_size_${width}x${height}.zip`);
      show(`Exported ${entries.length} image${entries.length > 1 ? 's' : ''} (${width}×${height})`);
    } catch (err) {
      show(err.message || 'Export failed', 'error');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      {assets.length === 0 ? (
        <DropZone onFiles={addFiles} accept="image/*" multiple icon="⤢">
          <div className="text-[13px] font-medium">Drop images here to sync size</div>
          <div className="text-[12px] text-muted">or click to browse · PNG, JPG, WebP, GIF</div>
        </DropZone>
      ) : (
        <>
          <Section
            title={`Images (${assets.length}) · max ${maxDim.w}×${maxDim.h}px`}
            actions={
              <div className="flex gap-2">
                <label className={`${ghostBtnClass} cursor-pointer`}>
                  + Add
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button onClick={clearAll} className={ghostBtnClass}>
                  Clear
                </button>
              </div>
            }
          >
            <div className="flex flex-col max-h-48 overflow-y-auto pr-1">
              {assets.map((a) => {
                const isSelected = selectedAsset?.id === a.id;
                return (
                  <div
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    className={`flex items-center gap-3 py-1.5 px-2 rounded-md cursor-pointer border-b border-border last:border-none ${
                      isSelected ? 'bg-accent2/[0.1]' : 'hover:bg-panel'
                    }`}
                  >
                    <span className="w-8 h-8 flex-shrink-0 rounded-md border border-border bg-bg flex items-center justify-center overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.url} alt="" className="max-w-full max-h-full" />
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[12.5px]" title={a.name}>
                      {a.name}
                    </span>
                    <span className="text-[11px] text-muted flex-shrink-0">
                      {a.w}×{a.h} →{' '}
                      <span className="text-accent2">
                        {width}×{height}
                      </span>
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAsset(a.id);
                      }}
                      title="Remove"
                      className="flex-shrink-0 text-muted hover:text-red-400 text-[13px] leading-none px-1"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Settings">
            <div className="flex flex-wrap items-start gap-6">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-2.5">
                  <label className="flex flex-col gap-1.5 text-[12.5px] text-muted">
                    Width
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      value={inputW}
                      onChange={(e) => handleWidthChange(e.target.value)}
                      onBlur={commitWidth}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                      className={numInputClass}
                    />
                  </label>
                  <span className="text-muted pb-1.5 text-[13px]">×</span>
                  <label className="flex flex-col gap-1.5 text-[12.5px] text-muted">
                    Height
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      value={inputH}
                      onChange={(e) => handleHeightChange(e.target.value)}
                      onBlur={commitHeight}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                      className={numInputClass}
                    />
                  </label>
                  <button
                    onClick={() => applyDimensions(height, width)}
                    title="Swap width and height"
                    className={ghostBtnClass}
                  >
                    ⇄
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => applyDimensions(maxDim.w, maxDim.h)}
                    className={`px-2 py-1 rounded-md text-[11px] border ${
                      width === maxDim.w && height === maxDim.h
                        ? 'bg-accent2/[0.16] border-accent2/40 text-text'
                        : 'bg-transparent border-border text-muted hover:text-text'
                    }`}
                  >
                    Max ({maxDim.w}×{maxDim.h})
                  </button>
                  {SIZE_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => applyDimensions(v, v)}
                      className={`px-2 py-1 rounded-md text-[11px] border ${
                        width === v && height === v
                          ? 'bg-accent2/[0.16] border-accent2/40 text-text'
                          : 'bg-transparent border-border text-muted hover:text-text'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-1.5 text-[12.5px] text-muted">
                  <span>Resize mode</span>
                  <div className="flex flex-wrap gap-1.5">
                    {FIT_MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setFitMode(m.id)}
                        title={m.hint}
                        className={`px-2.5 py-1 rounded-lg text-[12px] border ${
                          fitMode === m.id
                            ? 'bg-accent2/[0.16] border-accent2/40 text-text'
                            : 'bg-transparent border-border text-muted hover:text-text'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-muted">{activeFit.hint}</span>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-0.5 text-[12.5px] text-muted">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={pixelated}
                      onChange={(e) => setPixelated(e.target.checked)}
                      className="accent-accent2"
                    />
                    Pixel art
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={fillBg}
                      onChange={(e) => setFillBg(e.target.checked)}
                      className="accent-accent2"
                    />
                    Solid background
                  </label>
                  {fillBg && (
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      className="w-7 h-6 rounded bg-bg border border-border cursor-pointer p-0.5"
                    />
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 text-[12.5px] text-muted">
                <span>Expand direction</span>
                <div className="flex items-center gap-3.5">
                  <div className="grid grid-cols-3 gap-1 p-1.5 rounded-lg bg-bg border border-border">
                    {EXPAND_DIRECTIONS.map((d) => {
                      const active = d.id === direction;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          title={`Expand ${d.label}`}
                          onClick={() => setDirection(d.id)}
                          className={`w-8 h-8 rounded-md flex items-center justify-center text-[13px] border ${
                            active
                              ? 'bg-accent2 text-bg border-accent2 font-semibold'
                              : 'bg-panel2 border-border text-muted hover:text-text hover:border-accent'
                          }`}
                        >
                          {d.arrow}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="text-[13px] font-semibold text-text">
                      {activeDir.arrow} {activeDir.label}
                    </div>
                    <div className="text-[11px] text-muted max-w-[170px]">
                      {direction === 'center'
                        ? 'Expands canvas equally on all sides'
                        : `Expands canvas toward ${activeDir.label.toLowerCase()}`}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          <Section
            title={`Preview — ${width}×${height}px`}
            actions={
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={showBounds}
                    onChange={(e) => setShowBounds(e.target.checked)}
                    className="accent-accent2"
                  />
                  Bounds
                </label>
                <div className="flex gap-1">
                  {[
                    { id: 'single', label: 'Single' },
                    { id: 'grid', label: `Grid (${assets.length})` },
                  ].map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setViewMode(v.id)}
                      className={`px-2.5 py-1 rounded-lg text-[12px] border ${
                        viewMode === v.id
                          ? 'bg-accent2/[0.16] border-accent2/40 text-text'
                          : 'bg-transparent border-border text-muted hover:text-text'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleExport}
                  disabled={isExporting || !assets.length}
                  className={runBtnClass}
                >
                  {isExporting ? 'Exporting…' : `Export (${assets.length})`}
                </button>
              </div>
            }
          >
            <div
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(false);
                addFiles(e.dataTransfer.files);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                setDragOver(false);
              }}
              className={`relative bg-bg border rounded-lg p-4 overflow-auto ${
                dragOver ? 'border-accent' : 'border-border'
              }`}
            >
              {dragOver && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-accent/10 text-[12.5px] text-text rounded-lg pointer-events-none">
                  Drop to add images
                </div>
              )}

              {viewMode === 'single' && selectedAsset && selectedPlacement ? (
                <div className="flex flex-col items-center justify-center min-h-[240px] gap-2.5">
                  <SyncStage
                    asset={selectedAsset}
                    targetW={width}
                    targetH={height}
                    maxBoxW={520}
                    maxBoxH={340}
                    allowUpscale
                    direction={direction}
                    fitMode={fitMode}
                    fillBg={fillBg}
                    bgColor={bgColor}
                    pixelated={pixelated}
                    showBounds={showBounds}
                  />
                  <div className="text-[11px] text-muted text-center">
                    <span className="text-text font-medium">{selectedAsset.name}.png</span> ·{' '}
                    {selectedAsset.w}×{selectedAsset.h} → {width}×{height}px · offset (
                    {selectedPlacement.x}, {selectedPlacement.y})
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {assets.map((a) => {
                    const isSelected = selectedAsset?.id === a.id;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => {
                          setSelectedId(a.id);
                          setViewMode('single');
                        }}
                        className={`flex flex-col items-center gap-2 p-2.5 rounded-lg border bg-panel2 text-left ${
                          isSelected ? 'border-accent2' : 'border-border hover:border-accent'
                        }`}
                      >
                        <div className="w-full h-32 flex items-center justify-center overflow-hidden">
                          <SyncStage
                            asset={a}
                            targetW={width}
                            targetH={height}
                            maxBoxW={124}
                            maxBoxH={124}
                            direction={direction}
                            fitMode={fitMode}
                            fillBg={fillBg}
                            bgColor={bgColor}
                            pixelated={pixelated}
                            showBounds={showBounds}
                            smallChecker
                          />
                        </div>
                        <div className="w-full min-w-0 text-center">
                          <div className="text-[12px] text-text truncate" title={a.name}>
                            {a.name}
                          </div>
                          <div className="text-[10.5px] text-muted">
                            {a.w}×{a.h} → {width}×{height}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {viewMode === 'single' && assets.length > 1 && (
              <div className="flex gap-1.5 mt-3 overflow-x-auto pb-1">
                {assets.map((a) => {
                  const active = selectedAsset?.id === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelectedId(a.id)}
                      title={`${a.name} (${a.w}×${a.h})`}
                      className={`flex-shrink-0 w-14 h-14 rounded-md border bg-bg flex items-center justify-center overflow-hidden p-1 ${
                        active
                          ? 'border-accent2 ring-1 ring-accent2'
                          : 'border-border hover:border-accent'
                      }`}
                    >
                      <SyncStage
                        asset={a}
                        targetW={width}
                        targetH={height}
                        maxBoxW={44}
                        maxBoxH={44}
                        direction={direction}
                        fitMode={fitMode}
                        fillBg={fillBg}
                        bgColor={bgColor}
                        pixelated={pixelated}
                        smallChecker
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </Section>
        </>
      )}

      <Toast toast={toast} />
    </div>
  );
}
