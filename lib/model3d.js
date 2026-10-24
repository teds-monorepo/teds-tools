/**
 * Pure helpers for the 3D Viewer page (app/model3d). No DOM, no three.js —
 * everything three-related lives in components/model3d/ModelViewport.jsx.
 */

export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'fbx'];

export const ACCEPT_ATTR = '.glb,.gltf,.obj,.stl,.fbx,model/gltf-binary,model/gltf+json';

export function detectFormat(fileName) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_EXTENSIONS.includes(ext) ? ext : null;
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
