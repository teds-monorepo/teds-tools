/**
 * Pure helpers for the Spine Viewer page (app/spine). No DOM, no WebGL —
 * everything runtime-related lives in components/spine/.
 */

export const ACCEPT_ATTR =
  '.json,.skel,.bytes,.atlas,.txt,.png,.jpg,.jpeg,.webp,.zip,application/zip';

/** Spine editor versions this viewer can render, mapped to runtime keys. For 3.8 only 3.8.99 is supported. */
export const RUNTIME_BY_MINOR = { 4.1: '41', 4.2: '42' };

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

export function runtimeKeyForVersion(version) {
  if (!version) return null;
  if (String(version) === '3.8.99') return '38';
  const m = String(version).match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return RUNTIME_BY_MINOR[`${m[1]}.${m[2]}`] || null;
}

export function runtimeLabelForKey(runtimeKey) {
  if (runtimeKey === '38') return '3.8';
  if (runtimeKey === '41') return '4.1';
  if (runtimeKey === '42') return '4.2';
  return String(runtimeKey || '');
}

export function detectVersionFromJson(text) {
  try {
    const data = JSON.parse(text);
    return data?.skeleton?.spine ? String(data.skeleton.spine) : null;
  } catch {
    return null;
  }
}

/** The .skel binary stores its version as a plain string near the start. */
export function detectVersionFromSkel(bytes) {
  if (!bytes) return null;
  const head = bytes.subarray(0, 128);
  let s = '';
  for (const b of head) s += b >= 32 && b < 127 ? String.fromCharCode(b) : '\n';
  const m = s.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Page image file names declared by a .atlas, in order. */
export function parseAtlasPages(atlasText) {
  const pages = [];
  const lines = String(atlasText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line) || line.includes(':')) continue;
    if (/^size\s*:/.test(lines[i + 1].trim())) pages.push(line.trim());
  }
  return pages;
}

export function baseSpineName(name) {
  return String(name || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
}

/**
 * Strip Spine / Unity multi-part extensions (`.skel.bytes`, `.atlas.txt`,
 * `.json`, `.skel`, `.atlas`) so `hero.skel.bytes` and `hero.atlas.txt` still
 * pair under stem `hero`.
 */
export function spineStem(name) {
  const b = baseSpineName(name)
    .replace(/\.atlas\.txt$/, '')
    .replace(/\.skel\.bytes$/, '')
    .replace(/\.json\.txt$/, '');
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}

function rawExt(name) {
  const b = baseSpineName(name);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot + 1) : '';
}

export function isSkeletonFile(name) {
  const b = baseSpineName(name);
  if (b.endsWith('.atlas.txt')) return false;
  return b.endsWith('.json') || b.endsWith('.skel') || b.endsWith('.skel.bytes');
}

export function isJsonSkeletonFile(name) {
  return baseSpineName(name).endsWith('.json');
}

export function isAtlasFile(name) {
  const b = baseSpineName(name);
  return b.endsWith('.atlas') || b.endsWith('.atlas.txt');
}

export function isImageFile(name) {
  return IMAGE_EXTS.includes(rawExt(name));
}

export function isCompanionSpineFile(name) {
  return isAtlasFile(name) || isImageFile(name);
}

/**
 * Group a flat file list into skeleton sets. Entries pass through untouched;
 * only their `name` is read. A set is one .json/.skel + its .atlas + the page
 * images that atlas declares. Optional `companions` (`{ atlases, images }`)
 * supplies previously dropped .atlas / texture files when users drop assets in
 * separate steps.
 */
export function groupSpineFiles(entries, companions = null) {
  const list = Array.from(entries || []);
  const skeletons = list.filter((e) => isSkeletonFile(e.name));
  const batchAtlases = list.filter((e) => isAtlasFile(e.name));
  const poolAtlases = companions?.atlases ? Array.from(companions.atlases.values()) : [];
  const allAtlases = [
    ...batchAtlases,
    ...poolAtlases.filter(
      (a) => !batchAtlases.some((b) => baseSpineName(b.name) === baseSpineName(a.name))
    ),
  ];

  const byBase = new Map();
  if (companions?.images) {
    for (const [k, v] of companions.images.entries()) byBase.set(k, v);
  }
  for (const img of list.filter((e) => isImageFile(e.name))) {
    byBase.set(baseSpineName(img.name), img);
  }

  return skeletons.map((skeleton) => {
    const wantStem = spineStem(skeleton.name);
    const atlas =
      batchAtlases.find((a) => spineStem(a.name) === wantStem) ||
      allAtlases.find((a) => spineStem(a.name) === wantStem) ||
      (batchAtlases.length === 1 ? batchAtlases[0] : null) ||
      (allAtlases.length === 1 ? allAtlases[0] : null);
    return { skeleton, atlas, images: byBase, missing: [] };
  });
}

/** Fill `missing`/`pages` on a group once its atlas text is known. */
export function resolveAtlasPages(group, atlasText) {
  const pages = parseAtlasPages(atlasText);
  const missing = [];
  if (!group.atlas) missing.push('(.atlas file)');
  for (const page of pages) {
    if (!group.images.has(baseSpineName(page))) missing.push(page);
  }
  return { ...group, pages, missing };
}

/** One-line summary of the loaded skeleton, rendered in the sidebar. */
export function describeSpineStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.bones != null) parts.push(`${stats.bones} bone${stats.bones === 1 ? '' : 's'}`);
  if (stats.slots != null) parts.push(`${stats.slots} slot${stats.slots === 1 ? '' : 's'}`);
  if (stats.animations) parts.push(`${stats.animations} anim`);
  if (stats.skins > 1) parts.push(`${stats.skins} skins`);
  return parts.join(' · ');
}
