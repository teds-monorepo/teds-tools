/**
 * Loads the Spine runtime matching a skeleton's version and builds a
 * version-neutral handle around it. 4.1/4.2 come from the aliased
 * @esotericsoftware/spine-webgl npm packages; 3.8 was never published to npm,
 * so its official UMD build is vendored at public/spine/spine-webgl-3.8.js
 * (spine-runtimes repo, branch 3.8) and loaded on demand.
 */

const runtimeCache = {};

export function loadRuntime(runtimeKey) {
  if (!runtimeCache[runtimeKey]) {
    runtimeCache[runtimeKey] =
      runtimeKey === '38'
        ? loadScriptRuntime()
        : runtimeKey === '41'
          ? import('spine41')
          : import('spine42');
  }
  return runtimeCache[runtimeKey];
}

function loadScriptRuntime() {
  return new Promise((resolve, reject) => {
    const finish = () => {
      // The 3.8 UMD build puts WebGL classes under spine.webgl while core
      // classes sit at the top level; the 4.x npm packages flatten both.
      if (window.spine?.webgl) resolve({ ...window.spine, ...window.spine.webgl });
      else reject(new Error('Spine 3.8 runtime loaded but window.spine is missing.'));
    };
    if (window.spine?.webgl) return finish();
    const script = document.createElement('script');
    script.src = '/spine/spine-webgl-3.8.js';
    script.onload = finish;
    script.onerror = () => reject(new Error('Failed to load the Spine 3.8 runtime.'));
    document.head.appendChild(script);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load a texture page image.'));
    img.src = url;
  });
}

/**
 * @param spine runtime namespace for the skeleton's version
 * @param {{atlasText: string, pageUrls: Map<string,string>, skeletonText?: string,
 *          skeletonBytes?: Uint8Array}} input pageUrls keys are lowercase basenames
 */
export async function createSkeleton(
  spine,
  glContext,
  { atlasText, pageUrls, skeletonText, skeletonBytes }
) {
  const images = new Map();
  for (const [name, url] of pageUrls) images.set(name, await loadImage(url));

  const atlas = new spine.TextureAtlas(atlasText, (path) => {
    const img = images.get(path.split(/[\\/]/).pop().toLowerCase());
    if (!img) throw new Error(`Texture page not loaded: ${path}`);
    return new spine.GLTexture(glContext, img, false);
  });

  const loader = new spine.AtlasAttachmentLoader(atlas);
  const data = skeletonBytes
    ? new spine.SkeletonBinary(loader).readSkeletonData(skeletonBytes)
    : new spine.SkeletonJson(loader).readSkeletonData(skeletonText);

  const skeleton = new spine.Skeleton(data);
  skeleton.setToSetupPose();
  const stateData = new spine.AnimationStateData(data);
  const state = new spine.AnimationState(stateData);

  return {
    spine,
    data,
    skeleton,
    state,
    stateData,
    animations: data.animations.map((a) => ({ name: a.name, duration: a.duration })),
    skins: data.skins.map((s) => s.name),
    defaultPma: atlas.pages.some((p) => p.pma),
    updateWorldTransform() {
      // 4.2 takes a Physics argument; 3.8/4.1 take none.
      if (spine.Physics?.update !== undefined) skeleton.updateWorldTransform(spine.Physics.update);
      else skeleton.updateWorldTransform();
    },
    bounds() {
      this.updateWorldTransform();
      const offset = new spine.Vector2();
      const size = new spine.Vector2();
      skeleton.getBounds(offset, size, []);
      return { x: offset.x, y: offset.y, width: size.x, height: size.y };
    },
    setSkin(name) {
      skeleton.setSkinByName(name);
      skeleton.setSlotsToSetupPose();
    },
    setCustomSkin(names) {
      const custom = new spine.Skin('custom-skin');
      for (const name of names) {
        const skin = data.findSkin(name);
        if (skin) custom.addSkin(skin);
      }
      skeleton.setSkin(custom);
      skeleton.setSlotsToSetupPose();
    },
    dispose() {
      for (const page of atlas.pages) page.texture?.dispose?.();
      atlas.dispose?.();
    },
  };
}
