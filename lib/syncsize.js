// Pure helpers for the Assets Tools Sync Size tool: 9-way expand directions,
// resize/canvas placement math, dimension clamping, and output filename deduplication.

export const EXPAND_DIRECTIONS = [
  { id: 'top-left', label: 'Top Left', arrow: '↖' },
  { id: 'top', label: 'Top', arrow: '↑' },
  { id: 'top-right', label: 'Top Right', arrow: '↗' },
  { id: 'left', label: 'Left', arrow: '←' },
  { id: 'center', label: 'Center', arrow: '✥' },
  { id: 'right', label: 'Right', arrow: '→' },
  { id: 'down-left', label: 'Down Left', arrow: '↙' },
  { id: 'down', label: 'Down', arrow: '↓' },
  { id: 'down-right', label: 'Down Right', arrow: '↘' },
];

export const FIT_MODES = [
  { id: 'canvas', label: 'Canvas', hint: 'Keep 1:1 pixel size; expand or crop canvas' },
  {
    id: 'scale-down',
    label: 'Scale down',
    hint: 'Shrink oversized images to fit; keep smaller 1:1',
  },
  { id: 'contain', label: 'Contain', hint: 'Scale proportionally to fit inside target size' },
  { id: 'cover', label: 'Cover', hint: 'Scale proportionally to fill target size' },
  { id: 'stretch', label: 'Stretch', hint: 'Stretch to exact target width and height' },
];

export function clampDimension(value, fallback = 1, max = 8192) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}

export function maxDimensions(items, fallback = { w: 256, h: 256 }) {
  if (!items || items.length === 0) return fallback;
  let w = 1;
  let h = 1;
  for (const item of items) {
    if (item.w > w) w = item.w;
    if (item.h > h) h = item.h;
  }
  return { w: clampDimension(w), h: clampDimension(h) };
}

/**
 * Compute integer draw rect `{ x, y, w, h }` for placing a `srcW x srcH` image
 * onto a `targetW x targetH` canvas while expanding toward `direction`.
 *
 * Expand direction defines where extra canvas space grows:
 * - `'top'` grows upward (extra space above image -> `y = targetH - h`)
 * - `'down'` grows downward (extra space below image -> `y = 0`)
 * - `'left'` grows leftward (extra space left of image -> `x = targetW - w`)
 * - `'right'` grows rightward (extra space right of image -> `x = 0`)
 * - `'center'` grows equally around all sides
 */
export function computeSyncPlacement(
  srcW,
  srcH,
  targetW,
  targetH,
  direction = 'center',
  fitMode = 'canvas'
) {
  const sw = Math.max(1, srcW || 1);
  const sh = Math.max(1, srcH || 1);
  const tw = clampDimension(targetW, 1);
  const th = clampDimension(targetH, 1);

  let w = sw;
  let h = sh;

  if (fitMode === 'scale-down') {
    const s = Math.min(1, tw / sw, th / sh);
    w = Math.max(1, Math.round(sw * s));
    h = Math.max(1, Math.round(sh * s));
  } else if (fitMode === 'contain') {
    const s = Math.min(tw / sw, th / sh);
    w = Math.max(1, Math.round(sw * s));
    h = Math.max(1, Math.round(sh * s));
  } else if (fitMode === 'cover') {
    const s = Math.max(tw / sw, th / sh);
    w = Math.max(1, Math.round(sw * s));
    h = Math.max(1, Math.round(sh * s));
  } else if (fitMode === 'stretch') {
    w = tw;
    h = th;
  }

  const dx = tw - w;
  const dy = th - h;

  let x;
  if (direction === 'top-left' || direction === 'left' || direction === 'down-left') {
    x = dx;
  } else if (direction === 'top-right' || direction === 'right' || direction === 'down-right') {
    x = 0;
  } else {
    x = Math.floor(dx / 2);
  }

  let y;
  if (direction === 'top-left' || direction === 'top' || direction === 'top-right') {
    y = dy;
  } else if (direction === 'down-left' || direction === 'down' || direction === 'down-right') {
    y = 0;
  } else {
    y = Math.floor(dy / 2);
  }

  return { x: x || 0, y: y || 0, w, h };
}

/** Build collision-free `.png` filenames (case-insensitive) for ZIP export. */
export function uniquePngNames(baseNames) {
  const used = new Set();
  return baseNames.map((raw) => {
    const base = String(raw || 'image').trim() || 'image';
    let candidate = `${base}.png`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}_${n++}.png`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
