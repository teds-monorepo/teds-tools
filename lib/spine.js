/**
 * Pure helpers for the Spine Viewer page (app/spine). No DOM, no WebGL —
 * everything runtime-related lives in components/spine/.
 */

export const ACCEPT_ATTR = '.json,.skel,.atlas,.png,.jpg,.jpeg,.webp,.zip,application/zip';

/** Spine editor versions this viewer can render, mapped to runtime keys. For 3.8 only 3.8.99 is supported. */
export const RUNTIME_BY_MINOR = { '4.1': '41', '4.2': '42' };

export function runtimeKeyForVersion(version) {
  if (!version) return null;
  if (String(version) === '3.8.99') return '38';
  const m = String(version).match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return RUNTIME_BY_MINOR[`${m[1]}.${m[2]}`] || null;
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

function base(name) {
  return String(name || '').split(/[\\/]/).pop().toLowerCase();
}

function stem(name) {
  const b = base(name);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}

function ext(name) {
  const b = base(name);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot + 1) : '';
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

/**
 * Group a flat file list into skeleton sets. Entries pass through untouched;
 * only their `name` is read. A set is one .json/.skel + its .atlas + the page
 * images that atlas declares. `missing` lists atlas/image names not dropped.
 */
export function groupSpineFiles(entries) {
  const list = Array.from(entries || []);
  const skeletons = list.filter((e) => ['json', 'skel'].includes(ext(e.name)));
  const atlases = list.filter((e) => ext(e.name) === 'atlas');
  const images = list.filter((e) => IMAGE_EXTS.includes(ext(e.name)));
  const byBase = new Map(images.map((e) => [base(e.name), e]));

  return skeletons.map((skeleton) => {
    const atlas =
      atlases.find((a) => stem(a.name) === stem(skeleton.name)) ||
      (atlases.length === 1 ? atlases[0] : null);
    return { skeleton, atlas, images: byBase, missing: [] };
  });
}

/** Fill `missing`/`pages` on a group once its atlas text is known. */
export function resolveAtlasPages(group, atlasText) {
  const pages = parseAtlasPages(atlasText);
  const missing = [];
  if (!group.atlas) missing.push('(.atlas file)');
  for (const page of pages) {
    if (!group.images.has(base(page))) missing.push(page);
  }
  return { ...group, pages, missing };
}
