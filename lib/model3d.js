/**
 * Pure helpers for the 3D Viewer page (app/model3d). No DOM, no three.js —
 * everything three-related lives in components/model3d/ModelViewport.jsx.
 */

export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'fbx'];

/**
 * Files an .obj / .gltf can reference. They are never opened as models on their
 * own — they only travel alongside one, so the loader can resolve them by name.
 */
export const MATERIAL_EXTENSIONS = ['mtl'];
/** Binary payloads a .gltf can point at. */
export const BINARY_EXTENSIONS = ['bin'];
export const TEXTURE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tga',
  'dds',
  'hdr',
  'ktx2',
];

export const ACCEPT_ATTR =
  '.glb,.gltf,.obj,.stl,.fbx,.mtl,.bin,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.dds,.hdr,.ktx2,' +
  'model/gltf-binary,model/gltf+json';

function extensionOf(fileName) {
  return (fileName || '').split('.').pop()?.toLowerCase() || '';
}

export function detectFormat(fileName) {
  const ext = extensionOf(fileName);
  return SUPPORTED_EXTENSIONS.includes(ext) ? ext : null;
}

export function isCompanionFile(fileName) {
  const ext = extensionOf(fileName);
  return (
    MATERIAL_EXTENSIONS.includes(ext) ||
    BINARY_EXTENSIONS.includes(ext) ||
    TEXTURE_EXTENSIONS.includes(ext)
  );
}

/**
 * Last path segment, lowercased and without query/hash. Works on both file
 * names and the URLs a loader builds out of them (`blob:.../textures/wood.png`,
 * `blob:.../C:\textures\wood.png`), so materials authored on Windows still
 * match the file the user dropped.
 */
export function baseFileName(nameOrUrl) {
  const path = String(nameOrUrl || '').split(/[?#]/)[0];
  const base = path.split(/[\\/]/).pop() || '';
  try {
    return decodeURIComponent(base).toLowerCase();
  } catch {
    return base.toLowerCase();
  }
}

/** File name without directories or extension, lowercased. */
function stemOf(nameOrUrl) {
  const base = baseFileName(nameOrUrl);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Pick the .mtl belonging to a model: the one sharing its base name, otherwise
 * the only material file in the batch. Returns the matching resource name.
 */
export function pickMaterialFile(modelName, resourceNames = []) {
  const materialFiles = resourceNames.filter((n) => extensionOf(n) === 'mtl');
  if (!materialFiles.length) return null;
  const wantStem = stemOf(modelName);
  const sameStem = materialFiles.find((n) => stemOf(n) === wantStem);
  return sameStem || (materialFiles.length === 1 ? materialFiles[0] : null);
}

/**
 * Blob URL for a resource the loaders referenced by name/path, or null.
 * `resources` maps a base file name (see baseFileName) to a blob URL.
 */
export function findResourceUrl(resources, nameOrPath) {
  if (!resources) return null;
  // Inline assets (embedded glTF buffers/textures) never map to a dropped file.
  if (typeof nameOrPath !== 'string' || nameOrPath.startsWith('data:')) return null;
  return resources[baseFileName(nameOrPath)] ?? null;
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[u]}`;
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** One-line summary of the loaded scene, rendered under the viewport. */
export function describeStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.meshes) parts.push(`${stats.meshes} mesh${stats.meshes > 1 ? 'es' : ''}`);
  if (stats.vertices != null) parts.push(`${stats.vertices.toLocaleString()} verts`);
  if (stats.triangles != null) parts.push(`${stats.triangles.toLocaleString()} tris`);
  if (stats.animations) parts.push(`${stats.animations} anim`);
  return parts.join(' · ');
}
