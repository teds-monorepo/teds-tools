/**
 * Loads the Spine runtime matching a skeleton's version and builds a
 * version-neutral handle around it. 4.1/4.2 come from the aliased
 * @esotericsoftware/spine-webgl npm packages; 3.8 was never published to npm,
 * so its official UMD build is vendored at public/spine/spine-webgl-3.8.js
 * (spine-runtimes repo, branch 3.8) and loaded on demand.
 */

const runtimeCache = {};

const BLEND_NAMES = ['Normal', 'Additive', 'Multiply', 'Screen'];

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

function isPow2(n) {
  return n > 0 && (n & (n - 1)) === 0;
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
 * Temporarily clear `slot.attachment` for hidden slot names without calling
 * `slot.setAttachment(null)` (which would wipe deform vertices and sequence state).
 */
export function withHiddenSlots(skeleton, hiddenSet, fn) {
  if (!hiddenSet || hiddenSet.size === 0) return fn();
  const saved = [];
  const slots = skeleton.slots || [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.attachment != null && hiddenSet.has(slot.data?.name)) {
      saved.push([slot, slot.attachment]);
      slot.attachment = null;
    }
  }
  try {
    return fn();
  } finally {
    for (let i = 0; i < saved.length; i++) {
      saved[i][0].attachment = saved[i][1];
    }
  }
}

/**
 * @param spine runtime namespace for the skeleton's version
 * @param {{atlasText: string, pageUrls: Map<string,string>, pageSizes?: Map<string,number>,
 *          skeletonText?: string, skeletonBytes?: Uint8Array}} input pageUrls keys are lowercase basenames
 */
export async function createSkeleton(
  spine,
  glContext,
  { atlasText, pageUrls, pageSizes, skeletonText, skeletonBytes }
) {
  const images = new Map();
  for (const [name, url] of pageUrls) images.set(name, await loadImage(url));

  const atlas = new spine.TextureAtlas(atlasText, (path) => {
    const img = images.get(path.split(/[\\/]/).pop().toLowerCase());
    if (!img) throw new Error(`Texture page not loaded: ${path}`);
    return new spine.GLTexture(glContext, img, false);
  });
  // WebGL1 cannot sample a non-power-of-two texture with mipmapped filters; it renders black instead.
  for (const page of atlas.pages) {
    const img = page.texture?.getImage?.();
    if (img && (!isPow2(img.width) || !isPow2(img.height))) {
      page.texture.setFilters(spine.TextureFilter.Linear, spine.TextureFilter.Linear);
    }
  }

  const loader = new spine.AtlasAttachmentLoader(atlas);
  const data = skeletonBytes
    ? new spine.SkeletonBinary(loader).readSkeletonData(skeletonBytes)
    : new spine.SkeletonJson(loader).readSkeletonData(skeletonText);

  const skeleton = new spine.Skeleton(data);
  const initialSkinObj =
    (data.skins || []).find((s) => s.name !== 'default') || data.skins?.[0] || data.defaultSkin;
  if (initialSkinObj) skeleton.setSkin(initialSkinObj);
  skeleton.setToSetupPose();
  const stateData = new spine.AnimationStateData(data);
  const state = new spine.AnimationState(stateData);

  const updateWorldTransform = () => {
    // 4.2 takes a Physics argument; 3.8/4.1 take none.
    if (spine.Physics?.update !== undefined) skeleton.updateWorldTransform(spine.Physics.update);
    else skeleton.updateWorldTransform();
  };

  const computeBounds = (hiddenSet = null) =>
    withHiddenSlots(skeleton, hiddenSet, () => {
      updateWorldTransform();
      const offset = new spine.Vector2();
      const size = new spine.Vector2();
      skeleton.getBounds(offset, size, []);
      const valid =
        Number.isFinite(offset.x) &&
        Number.isFinite(offset.y) &&
        Number.isFinite(size.x) &&
        Number.isFinite(size.y) &&
        size.x > 0 &&
        size.y > 0;
      // No visible attachment in the current pose gives infinite bounds; fall back to editor bounds.
      if (!valid) {
        const w = data.width > 0 ? data.width : 200;
        const h = data.height > 0 ? data.height : 200;
        return { x: data.x || -w / 2, y: data.y || 0, width: w, height: h, fallback: true };
      }
      return { x: offset.x, y: offset.y, width: size.x, height: size.y, fallback: false };
    });

  return {
    spine,
    atlas,
    data,
    skeleton,
    state,
    stateData,
    animations: data.animations.map((a) => ({ name: a.name, duration: a.duration })),
    skins: data.skins.map((s) => s.name),
    initialSkin: initialSkinObj?.name || '',
    defaultPma: atlas.pages.some((p) => p.pma),
    updateWorldTransform,
    bounds: computeBounds,
    inspect(hiddenSet = null) {
      return inspectSkeleton(spine, data, skeleton, atlas, pageSizes, computeBounds(hiddenSet));
    },
    seek(time) {
      const entry = state.tracks[0];
      if (!entry?.animation) return;
      const duration = entry.animation.duration || 0;
      entry.trackTime = entry.loop && duration > 0 ? time % duration : Math.min(time, duration);
      entry.setAnimationLast?.(entry.getAnimationTime());
      state.apply(skeleton);
      updateWorldTransform();
    },
    setFlip(flipX, flipY) {
      skeleton.scaleX = flipX ? -1 : 1;
      skeleton.scaleY = flipY ? -1 : 1;
      updateWorldTransform();
    },
    resetToSetupPose() {
      const activeSkin = skeleton.skin;
      state.clearTracks();
      skeleton.setToSetupPose();
      if (activeSkin) {
        skeleton.setSkin(activeSkin);
        skeleton.setSlotsToSetupPose();
      }
      updateWorldTransform();
    },
    setSkin(name) {
      skeleton.setSkin(null);
      skeleton.setSkinByName(name);
      skeleton.setSlotsToSetupPose();
      state.apply(skeleton);
      updateWorldTransform();
    },
    setCustomSkin(names) {
      const custom = new spine.Skin('custom-skin');
      for (const name of names) {
        const skin = data.findSkin(name);
        if (skin) custom.addSkin(skin);
      }
      skeleton.setSkin(null);
      skeleton.setSkin(custom);
      skeleton.setSlotsToSetupPose();
      state.apply(skeleton);
      updateWorldTransform();
    },
    dispose() {
      for (const page of atlas.pages) page.texture?.dispose?.();
      atlas.dispose?.();
    },
  };
}

function colorToHex(c) {
  if (!c) return null;
  const ch = (v) =>
    Math.max(0, Math.min(255, Math.round((v ?? 1) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

function filterName(spine, code) {
  const tf = spine.TextureFilter || {};
  for (const [k, v] of Object.entries(tf)) {
    if (v === code && isNaN(Number(k))) return k;
  }
  return 'Linear';
}

function describeAttachment(spine, att) {
  if (!att) return { type: 'Empty', vertices: 0, triangles: 0, texturePage: null };
  if (spine.RegionAttachment && att instanceof spine.RegionAttachment) {
    return {
      type: 'Region',
      vertices: 4,
      triangles: 2,
      texturePage: att.region?.page || att.region?.renderObject?.page || null,
    };
  }
  if (spine.MeshAttachment && att instanceof spine.MeshAttachment) {
    const verts = Math.round((att.worldVerticesLength || 0) / 2);
    const tris = Math.round((att.triangles?.length || 0) / 3);
    const weighted = Boolean(att.bones && att.bones.length > 0);
    return {
      type: weighted ? 'Weighted Mesh' : 'Mesh',
      vertices: verts,
      triangles: tris,
      weighted,
      texturePage: att.region?.page || att.region?.renderObject?.page || null,
    };
  }
  if (spine.ClippingAttachment && att instanceof spine.ClippingAttachment) {
    return {
      type: 'Clipping',
      vertices: Math.round((att.worldVerticesLength || 0) / 2),
      triangles: 0,
      texturePage: null,
    };
  }
  if (spine.BoundingBoxAttachment && att instanceof spine.BoundingBoxAttachment) {
    return {
      type: 'Bounds',
      vertices: Math.round((att.worldVerticesLength || 0) / 2),
      triangles: 0,
      texturePage: null,
    };
  }
  if (spine.PathAttachment && att instanceof spine.PathAttachment) {
    return {
      type: 'Path',
      vertices: Math.round((att.worldVerticesLength || 0) / 2),
      triangles: 0,
      texturePage: null,
    };
  }
  if (spine.PointAttachment && att instanceof spine.PointAttachment) {
    return { type: 'Point', vertices: 1, triangles: 0, texturePage: null };
  }
  return { type: 'Attachment', vertices: 0, triangles: 0, texturePage: null };
}

/**
 * Extract rich skeleton, slot, bone, skin, atlas, animation and event
 * specifications across Spine 3.8, 4.1 and 4.2.
 */
function inspectSkeleton(spine, data, skeleton, atlas, pageSizes, bounds) {
  // Total unique attachments across all skins.
  let totalAttachments = 0;
  const skinList = (data.skins || []).map((skin) => {
    const entries = skin.getAttachments ? skin.getAttachments() : [];
    totalAttachments += entries.length;
    let meshCount = 0;
    let regionCount = 0;
    for (const entry of entries) {
      const att = entry?.attachment;
      if (spine.MeshAttachment && att instanceof spine.MeshAttachment) meshCount++;
      else if (spine.RegionAttachment && att instanceof spine.RegionAttachment) regionCount++;
    }
    return {
      name: skin.name,
      attachments: entries.length,
      regions: regionCount,
      meshes: meshCount,
      bones: skin.bones?.length || 0,
      constraints: skin.constraints?.length || 0,
    };
  });

  // Pose geometry + batching draw-call estimate in current drawOrder.
  let vertices = 0;
  let triangles = 0;
  let regionAttachments = 0;
  let meshAttachments = 0;
  let weightedMeshes = 0;
  let clippingAttachments = 0;
  let pathAttachments = 0;
  let boundingBoxAttachments = 0;
  let blendSlotCount = 0;
  let drawCalls = 0;
  let prevPage = null;
  let prevBlend = null;

  for (const slot of skeleton.drawOrder || []) {
    const blend = slot.data?.blendMode ?? 0;
    if (blend !== 0) blendSlotCount++;
    const att = slot.getAttachment ? slot.getAttachment() : slot.attachment;
    if (!att) continue;
    const info = describeAttachment(spine, att);
    vertices += info.vertices;
    triangles += info.triangles;
    if (info.type === 'Region') regionAttachments++;
    else if (info.type === 'Mesh' || info.type === 'Weighted Mesh') {
      meshAttachments++;
      if (info.weighted) weightedMeshes++;
    } else if (info.type === 'Clipping') clippingAttachments++;
    else if (info.type === 'Path') pathAttachments++;
    else if (info.type === 'Bounds') boundingBoxAttachments++;

    if (info.type === 'Region' || info.type === 'Mesh' || info.type === 'Weighted Mesh') {
      const page = info.texturePage || '__default';
      if (page !== prevPage || blend !== prevBlend) {
        drawCalls++;
        prevPage = page;
        prevBlend = blend;
      }
    }
  }

  const slotList = (skeleton.slots || []).map((slot, i) => {
    const sd = slot.data;
    const att = slot.getAttachment ? slot.getAttachment() : slot.attachment;
    const info = describeAttachment(spine, att);
    const blendIdx = sd?.blendMode ?? 0;
    return {
      index: sd?.index ?? i,
      name: sd?.name || `Slot ${i + 1}`,
      bone: sd?.boneData?.name || slot.bone?.data?.name || 'root',
      blendMode: BLEND_NAMES[blendIdx] || 'Normal',
      color: colorToHex(sd?.color),
      alpha: typeof sd?.color?.a === 'number' ? Number(sd.color.a.toFixed(2)) : 1,
      attachmentName: att?.name || sd?.attachmentName || null,
      attachmentType: info.type,
      vertices: info.vertices,
      triangles: info.triangles,
    };
  });

  // Bone hierarchy & max depth.
  let maxBoneDepth = 0;
  const boneList = (data.bones || []).map((b, i) => {
    let depth = 0;
    let cur = b.parent;
    while (cur && depth < 64) {
      depth++;
      cur = cur.parent;
    }
    if (depth > maxBoneDepth) maxBoneDepth = depth;
    return {
      index: b.index ?? i,
      name: b.name || `Bone ${i + 1}`,
      parent: b.parent?.name || null,
      depth,
      length: Number((b.length || 0).toFixed(1)),
      x: Number((b.x || 0).toFixed(1)),
      y: Number((b.y || 0).toFixed(1)),
      rotation: Number((b.rotation || 0).toFixed(1)),
      skinRequired: Boolean(b.skinRequired),
    };
  });

  // Animations + events mapping.
  const eventToAnims = new Map();
  const animList = (data.animations || []).map((anim) => {
    const timelines = anim.timelines || [];
    let keyframes = 0;
    const firedEvents = new Set();
    for (const tl of timelines) {
      const frames =
        typeof tl.getFrameCount === 'function' ? tl.getFrameCount() : tl.frames?.length || 0;
      keyframes += frames;
      if (Array.isArray(tl.events)) {
        for (const ev of tl.events) {
          const evName = ev?.data?.name;
          if (evName) {
            firedEvents.add(evName);
            if (!eventToAnims.has(evName)) eventToAnims.set(evName, []);
            const arr = eventToAnims.get(evName);
            if (!arr.includes(anim.name)) arr.push(anim.name);
          }
        }
      }
    }
    return {
      name: anim.name,
      duration: anim.duration || 0,
      timelines: timelines.length,
      keyframes,
      events: Array.from(firedEvents),
    };
  });

  const eventList = (data.events || []).map((ev) => ({
    name: ev.name,
    intValue: ev.intValue ?? 0,
    floatValue: ev.floatValue ?? 0,
    stringValue: ev.stringValue || null,
    audioPath: ev.audioPath || null,
    usedIn: eventToAnims.get(ev.name) || [],
  }));

  const pageList = (atlas.pages || []).map((page) => {
    const baseName = String(page.name || '')
      .split(/[\\/]/)
      .pop()
      .toLowerCase();
    const img = page.texture?.getImage?.();
    const pageRegions = (atlas.regions || []).filter((r) => r.page === page);
    return {
      name: page.name,
      width: page.width || img?.width || 0,
      height: page.height || img?.height || 0,
      sizeBytes: pageSizes?.get(baseName) || 0,
      pma: Boolean(page.pma),
      filter: filterName(spine, page.minFilter),
      regions: pageRegions.length,
      regionNames: pageRegions.slice(0, 12).map((r) => r.name),
    };
  });

  const ikConstraints = data.ikConstraints?.length || 0;
  const transformConstraints = data.transformConstraints?.length || 0;
  const pathConstraints = data.pathConstraints?.length || 0;
  const physicsConstraints = data.physicsConstraints?.length || 0;

  return {
    bones: boneList.length,
    maxBoneDepth,
    slots: slotList.length,
    skins: skinList.length,
    animations: animList.length,
    events: eventList.length,
    totalAttachments,
    vertices,
    triangles,
    drawCalls,
    regionAttachments,
    meshAttachments,
    weightedMeshes,
    clippingAttachments,
    pathAttachments,
    boundingBoxAttachments,
    blendSlotCount,
    ikConstraints,
    transformConstraints,
    pathConstraints,
    physicsConstraints,
    pages: pageList.length,
    regions: atlas.regions?.length || 0,
    fps: data.fps || 30,
    hash: data.hash || null,
    setupSize:
      data.width > 0 && data.height > 0
        ? {
            x: Number((data.x || 0).toFixed(2)),
            y: Number((data.y || 0).toFixed(2)),
            width: Number(data.width.toFixed(2)),
            height: Number(data.height.toFixed(2)),
          }
        : null,
    bounds: bounds
      ? {
          x: Number(bounds.x.toFixed(2)),
          y: Number(bounds.y.toFixed(2)),
          width: Number(bounds.width.toFixed(2)),
          height: Number(bounds.height.toFixed(2)),
        }
      : null,
    slotList,
    boneList,
    skinList,
    pageList,
    animList,
    eventList,
  };
}
