/** Minecraft-style voxel builders for the 3D office: noise-textured block props and blocky avatars (head, body, arms, legs). */
import * as THREE from 'three';

import type { Look } from '../office/sprites/layers.js';
import { LOOK_OPTIONS } from '../office/sprites/layers.js';
import { COL, css, SHADE } from './constants3d.js';
import type { Box3 } from './layout3d.js';
import { pixelTexture } from './pixelTextures.js';

/** Texture size for every voxel face (like a Minecraft block). */
export const VOXEL_PX = 16;

/** Deterministic 0..1 noise so a prop looks the same on every rebuild. */
export function hash01(seed: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) { h ^= seed.charCodeAt(k); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Shift a 0xRRGGBB colour toward black (k<1) or white (k>1). */
export function tint(n: number, k: number): number {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k <= 1 ? v * k : v + (255 - v) * (k - 1))));
  return (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255);
}

export function parseColor(c: string | number): number {
  return typeof c === 'number' ? c : parseInt(c.replace('#', ''), 16) || 0;
}

type Painter = (g: CanvasRenderingContext2D, base: number, seed: string) => void;

/** Fill 16x16 with a limited 3-shade palette of per-pixel noise around `base`. */
function noiseFill(g: CanvasRenderingContext2D, base: number, seed: string, spread = 0.18): void {
  const shades = [tint(base, 1 - spread), base, tint(base, 1 + spread)];
  for (let y = 0; y < VOXEL_PX; y++) for (let x = 0; x < VOXEL_PX; x++) {
    g.fillStyle = css(shades[Math.floor(hash01(seed, y * VOXEL_PX + x) * 3)]!);
    g.fillRect(x, y, 1, 1);
  }
}

function rect(g: CanvasRenderingContext2D, c: number, x: number, y: number, w: number, h: number): void {
  g.fillStyle = css(c); g.fillRect(x, y, w, h);
}

const PAINTERS: Record<string, Painter> = {
  /** Wood planks with dark seams and grain. */
  wood: (g, base, seed) => {
    noiseFill(g, base, seed, 0.1);
    for (let y = 0; y < VOXEL_PX; y += 4) rect(g, tint(base, 0.6), 0, y, VOXEL_PX, 1);
    for (let y = 0; y < VOXEL_PX; y += 4) rect(g, tint(base, 0.6), ((y / 4) % 2) * 8 + 4, y, 1, 4);
  },
  /** Bookshelf: dark frame, shelves, coloured spines. */
  shelf: (g, base, seed) => {
    noiseFill(g, tint(base, 0.7), seed, 0.1);
    for (const sy of [1, 6, 11]) {
      for (let x = 1; x < 15; x++) {
        if (hash01(seed, sy * 31 + x) > 0.18) rect(g, [COL.shirt[0]!, COL.shirt[1]!, COL.shirt[3]!, COL.shirt[4]!, base][Math.floor(hash01(seed, x + sy) * 5)]!, x, sy, 1, 4);
      }
      rect(g, tint(base, 0.45), 0, sy + 4, VOXEL_PX, 1);
    }
  },
  /** Metal casing with vents and a status LED. */
  metal: (g, base, seed) => {
    noiseFill(g, base, seed, 0.1);
    rect(g, tint(base, 0.55), 0, 0, VOXEL_PX, 1); rect(g, tint(base, 0.55), 0, 15, VOXEL_PX, 1);
    for (let y = 4; y < 11; y += 2) rect(g, tint(base, 0.6), 3, y, 10, 1);
    rect(g, COL.working, 13, 2, 2, 1);
  },
  /** Fabric seat with a stitched border. */
  fabric: (g, base, seed) => {
    noiseFill(g, base, seed, 0.12);
    for (let i = 1; i < 15; i += 2) { rect(g, tint(base, 0.75), i, 1, 1, 1); rect(g, tint(base, 0.75), i, 14, 1, 1); rect(g, tint(base, 0.75), 1, i, 1, 1); rect(g, tint(base, 0.75), 14, i, 1, 1); }
  },
  /** Leaves with bright tips on a dark base. */
  leaves: (g, base, seed) => {
    noiseFill(g, tint(base, 0.8), seed, 0.3);
    for (let i = 0; i < 40; i++) rect(g, tint(base, 1.35), Math.floor(hash01(seed, i * 2) * 16), Math.floor(hash01(seed, i * 2 + 1) * 16), 1, 1);
  },
  /** Painted canvas inside a wooden frame. */
  art: (g, base, seed) => {
    noiseFill(g, base, seed, 0.25);
    for (const [x, y, w, h] of [[0, 0, 16, 2], [0, 14, 16, 2], [0, 0, 2, 16], [14, 0, 2, 16]] as const) rect(g, COL.wallPxHi, x, y, w, h);
  },
  stone: (g, base, seed) => noiseFill(g, base, seed, 0.2),
};

const KIND_PAINTER: Record<Box3['kind'], keyof typeof PAINTERS> = {
  desk: 'wood', chair: 'fabric', storage: 'shelf', electronics: 'metal', decor: 'leaves', 'wall-art': 'art', misc: 'stone',
};

export interface VoxelKit {
  /** Cached lambert-free (unlit) material for a painted kind + colour + face shade. */
  material(painter: string, colour: number, shade: number): THREE.MeshBasicMaterial;
  dispose(): void;
}

/** Shares textures and materials across all props so the whole office stays a handful of GPU resources. */
export function createVoxelKit(): VoxelKit {
  const texs = new Map<string, THREE.CanvasTexture>();
  const mats = new Map<string, THREE.MeshBasicMaterial>();
  const texture = (painter: string, colour: number): THREE.CanvasTexture => {
    const key = `${painter}:${colour}`;
    let t = texs.get(key);
    if (!t) {
      const c = document.createElement('canvas'); c.width = VOXEL_PX; c.height = VOXEL_PX;
      (PAINTERS[painter] ?? PAINTERS['stone']!)(c.getContext('2d')!, colour, key);
      t = pixelTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping;
      texs.set(key, t);
    }
    return t;
  };
  return {
    material(painter, colour, shade) {
      const key = `${painter}:${colour}:${shade}`;
      let m = mats.get(key);
      if (!m) { m = new THREE.MeshBasicMaterial({ map: texture(painter, colour), color: new THREE.Color(shade, shade, shade) }); mats.set(key, m); }
      return m;
    },
    dispose() { texs.forEach((t) => t.dispose()); mats.forEach((m) => m.dispose()); texs.clear(); mats.clear(); },
  };
}

/** Per-face materials in BoxGeometry order: +x, -x, +y, -y, +z, -z. */
function faces(kit: VoxelKit, painter: string, colour: number): THREE.MeshBasicMaterial[] {
  const s = kit.material(painter, colour, SHADE.side), f = kit.material(painter, colour, SHADE.front);
  return [s, s, kit.material(painter, colour, SHADE.top), kit.material(painter, colour, 0.5), f, f];
}

/** Scale a box's texture so one texel stays ~1/16 m regardless of the part size. */
function part(kit: VoxelKit, painter: string, colour: number, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), faces(kit, painter, colour));
  m.position.set(x, y + h / 2, z);
  return m;
}

/** A block-built prop at the box's footprint: legs and slab for desks, seat and back for chairs, pot and bush for plants. */
export function buildVoxelProp(kit: VoxelKit, b: Box3): THREE.Group {
  const g = new THREE.Group();
  const w = b.w * 0.96, d = b.d * 0.96, base = parseColor(b.color);
  const painter = KIND_PAINTER[b.kind];
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const add = (m: THREE.Mesh) => { m.position.x += cx; m.position.y += b.y; m.position.z += cz; g.add(m); };
  switch (b.kind) {
    case 'desk': {
      const slab = 0.1, leg = 0.1;
      add(part(kit, 'wood', base, w, slab, d, 0, b.h - slab, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(part(kit, 'wood', tint(base, 0.7), leg, b.h - slab, leg, sx * (w / 2 - leg), 0, sz * (d / 2 - leg)));
      add(part(kit, 'wood', tint(base, 0.8), w - 0.2, 0.06, 0.04, 0, b.h - slab - 0.06, -(d / 2 - 0.1)));
      break;
    }
    case 'chair': {
      const seat = 0.1, legH = Math.max(0.1, b.h - seat);
      const back = b.orientation === 'back' ? 1 : -1;
      add(part(kit, 'fabric', base, w, seat, d, 0, legH, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(part(kit, 'metal', COL.border, 0.06, legH, 0.06, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)));
      add(part(kit, 'fabric', tint(base, 0.85), w, 0.5, 0.08, 0, legH + seat, back * (d / 2 - 0.04)));
      break;
    }
    case 'decor': {
      const potH = Math.min(0.28, b.h * 0.35);
      add(part(kit, 'wood', 0x9a5b34, w * 0.6, potH, d * 0.6, 0, 0, 0));
      add(part(kit, 'leaves', base, w * 0.8, (b.h - potH) * 0.55, d * 0.8, 0, potH, 0));
      add(part(kit, 'leaves', tint(base, 1.15), w * 0.5, (b.h - potH) * 0.45, d * 0.5, 0, potH + (b.h - potH) * 0.55, 0));
      break;
    }
    case 'wall-art': {
      const m = part(kit, painter, base, b.w, b.h, Math.max(0.06, b.d), 0, 0, 0);
      add(m);
      break;
    }
    default:
      add(part(kit, painter, base, w, b.h, d, 0, 0, 0));
      // Electronics get a darker bezel so they read as devices rather than slabs.
      if (b.kind === 'electronics') add(part(kit, 'metal', tint(base, 0.6), w * 0.7, 0.04, d * 0.7, 0, b.h, 0));
  }
  return g;
}

// ── avatars ──────────────────────────────────────────────────────
export const VOXEL_SCALE = 1 / 16;
/** Minecraft proportions in 1/16 m "pixels": head 8, body 8x12, limbs 4x12. */
const HEAD = 8, BODY_W = 8, BODY_H = 12, LIMB = 4, LIMB_H = 12;
/** Total standing height in metres (24 units * scale 1.0 → 1.5 m with VOXEL_SCALE 1/16). */
export const FIGURE_HEIGHT = (HEAD + BODY_H + LIMB_H) * VOXEL_SCALE;

export function lookColor(id: string | undefined, fallback: number): number {
  if (!id) return fallback;
  const c = (LOOK_OPTIONS.colors as Record<string, string>)[id] ?? id;
  return /^#?[0-9a-f]{6}$/i.test(c) ? parseColor(c) : fallback;
}

export interface FigureColors { skin: number; hair: number; shirt: number; pants: number; crown: boolean; glasses: boolean; hatColor: number | null }

export function figureColors(palette: number, look?: Look): FigureColors {
  const i = Math.abs(palette) % COL.skin.length;
  const hat = look?.hat && look.hat !== 'none' ? look.hat : null;
  return {
    skin: COL.skin[i]!,
    hair: lookColor(look?.hairColor, [0x2b2430, 0x6b4226, 0xe3c068, 0x9a3b26, 0x2b2430, 0x6b4226][i]!),
    shirt: lookColor(look?.outfitColor, COL.shirt[i]!),
    pants: COL.pants,
    crown: hat === 'crown',
    glasses: look?.accessory === 'glasses' || look?.accessory === 'sunglasses',
    hatColor: hat && hat !== 'crown' ? lookColor(look?.hatColor, COL.shirt[(i + 2) % 6]!) : null,
  };
}

function solidMat(c: number, shade = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(tint(c, shade)) });
}

/** Head cube with a pixel face on the front (+z) and hair on top/back/sides. */
function headMaterials(c: FigureColors, seed: string): THREE.MeshBasicMaterial[] {
  const cv = document.createElement('canvas'); cv.width = HEAD; cv.height = HEAD;
  const g = cv.getContext('2d')!;
  rect(g, c.skin, 0, 0, HEAD, HEAD);
  for (let i = 0; i < 6; i++) rect(g, tint(c.skin, 0.94), Math.floor(hash01(seed, i) * HEAD), 2 + Math.floor(hash01(seed, i + 9) * 6), 1, 1);
  rect(g, c.hair, 0, 0, HEAD, 2); rect(g, c.hair, 0, 2, 1, 1); rect(g, c.hair, 7, 2, 1, 1);
  const eye = c.glasses ? COL.ink : 0xffffff;
  rect(g, eye, 1, 4, 2, 1); rect(g, eye, 5, 4, 2, 1);
  rect(g, 0x3b2a6b, 2, 4, 1, 1); rect(g, 0x3b2a6b, 5, 4, 1, 1);
  rect(g, tint(c.skin, 0.75), 3, 6, 2, 1);
  const tex = pixelTexture(cv);
  const hairOnly = solidMat(c.hair);
  const sideCv = document.createElement('canvas'); sideCv.width = HEAD; sideCv.height = HEAD;
  const sg = sideCv.getContext('2d')!; rect(sg, c.skin, 0, 0, HEAD, HEAD); rect(sg, c.hair, 0, 0, HEAD, 3);
  const side = pixelTexture(sideCv);
  const m = (map: THREE.Texture, k: number) => new THREE.MeshBasicMaterial({ map, color: new THREE.Color(k, k, k) });
  return [m(side, SHADE.side), m(side, SHADE.side), hairOnly, solidMat(c.skin, 0.8), m(tex, 1), solidMat(c.hair, 0.85)];
}

export interface VoxelFigure {
  group: THREE.Group;
  /** Swing pivots, rotated each frame by `animateFigure`. */
  armL: THREE.Object3D; armR: THREE.Object3D; legL: THREE.Object3D; legR: THREE.Object3D; head: THREE.Object3D;
  dispose(): void;
}

function box(w: number, h: number, d: number, mats: THREE.Material | THREE.Material[]): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w * VOXEL_SCALE, h * VOXEL_SCALE, d * VOXEL_SCALE), mats);
}

/** A Minecraft-style character: cube head, 8x12 torso, 4x12 arms and legs on hip/shoulder pivots, plus crown or hat. Faces local +z. */
export function buildVoxelFigure(palette: number, look: Look | undefined, seed: string): VoxelFigure {
  const c = figureColors(palette, look);
  const g = new THREE.Group();
  const owned: Array<{ dispose(): void }> = [];
  const track = <T extends THREE.Object3D>(o: T): T => {
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.geometry) owned.push(m.geometry);
      const mm = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of Array.isArray(mm) ? mm : mm ? [mm] : []) { owned.push(mat); const mp = (mat as THREE.MeshBasicMaterial).map; if (mp) owned.push(mp); }
    });
    return o;
  };
  const mkLimb = (x: number, top: number, h: number, mat: THREE.Material[]): THREE.Group => {
    const pivot = new THREE.Group(); pivot.position.set(x * VOXEL_SCALE, top * VOXEL_SCALE, 0);
    const m = box(LIMB, h, LIMB, mat); m.position.y = -(h / 2) * VOXEL_SCALE; pivot.add(m);
    return pivot;
  };
  const shirtM = [solidMat(c.shirt, SHADE.side), solidMat(c.shirt, SHADE.side), solidMat(c.shirt), solidMat(c.shirt, 0.6), solidMat(c.shirt, SHADE.front), solidMat(c.shirt, 0.7)];
  const legM = [solidMat(c.pants, 1.1), solidMat(c.pants, 1.1), solidMat(c.pants, 1.2), solidMat(0x15162a), solidMat(c.pants), solidMat(c.pants, 0.8)];
  const legL = track(mkLimb(-2, LIMB_H, LIMB_H, legM)), legR = track(mkLimb(2, LIMB_H, LIMB_H, legM));
  // Shoes: a darker 2-unit cap at the foot of each leg.
  for (const l of [legL, legR]) { const s = box(LIMB + 0.4, 2, LIMB + 1, solidMat(0x1d1d2b)); s.position.set(0, -(LIMB_H - 1) * VOXEL_SCALE, 0.5 * VOXEL_SCALE); l.add(track(s)); }
  const armTop = LIMB_H + BODY_H;
  const skinArm = [solidMat(c.skin, SHADE.side), solidMat(c.skin, SHADE.side), solidMat(c.shirt), solidMat(c.skin, 0.8), solidMat(c.skin, SHADE.front), solidMat(c.skin, 0.8)];
  const armL = track(mkLimb(-6, armTop, BODY_H, skinArm)), armR = track(mkLimb(6, armTop, BODY_H, skinArm));
  // Sleeves over the upper arm.
  for (const a of [armL, armR]) { const s = box(LIMB + 0.5, 4, LIMB + 0.5, shirtM); s.position.y = -2 * VOXEL_SCALE; a.add(track(s)); }
  const torso = track(box(BODY_W, BODY_H, LIMB, shirtM)); torso.position.y = (LIMB_H + BODY_H / 2) * VOXEL_SCALE;
  const belt = track(box(BODY_W + 0.2, 1.5, LIMB + 0.2, solidMat(0x2b2430))); belt.position.y = (LIMB_H + 0.75) * VOXEL_SCALE;
  const head = new THREE.Group(); head.position.y = (LIMB_H + BODY_H) * VOXEL_SCALE;
  const skull = track(box(HEAD, HEAD, HEAD, headMaterials(c, seed))); skull.position.y = (HEAD / 2) * VOXEL_SCALE; head.add(skull);
  const fringe = track(box(HEAD + 0.6, 2, HEAD + 0.6, solidMat(c.hair, 1.1))); fringe.position.y = (HEAD - 0.5) * VOXEL_SCALE; head.add(fringe);
  if (c.crown) {
    const band = track(box(HEAD + 0.6, 2, HEAD + 0.6, solidMat(0xf0d54a))); band.position.y = (HEAD + 0.5) * VOXEL_SCALE; head.add(band);
    for (const [px, pz] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, 0]] as const) {
      const spike = track(box(1.6, 2.5, 1.6, solidMat(px === 0 ? 0xffe98a : 0xf0d54a))); spike.position.set(px * VOXEL_SCALE, (HEAD + 2.8) * VOXEL_SCALE, pz * VOXEL_SCALE); head.add(spike);
    }
  } else if (c.hatColor !== null) {
    const hat = track(box(HEAD + 1, 3, HEAD + 1, solidMat(c.hatColor))); hat.position.y = (HEAD + 1) * VOXEL_SCALE; head.add(hat);
  }
  g.add(torso, belt, legL, legR, armL, armR, head);
  return { group: g, armL, armR, legL, legR, head, dispose: () => owned.forEach((o) => o.dispose()) };
}

/** Walk swing / typing pose. `phase` is radians; typing holds the arms forward and bobs them. */
export function animateFigure(f: VoxelFigure, mode: 'idle' | 'walk' | 'type' | 'sit', phase: number): void {
  const swing = mode === 'walk' ? Math.sin(phase) * 0.7 : 0;
  f.legL.rotation.x = mode === 'sit' || mode === 'type' ? -Math.PI / 2 : swing;
  f.legR.rotation.x = mode === 'sit' || mode === 'type' ? -Math.PI / 2 : -swing;
  f.armL.rotation.x = mode === 'type' ? -1.2 + Math.sin(phase * 3) * 0.12 : -swing;
  f.armR.rotation.x = mode === 'type' ? -1.2 - Math.sin(phase * 3) * 0.12 : swing;
  f.head.rotation.x = mode === 'idle' ? Math.sin(phase * 0.5) * 0.03 : 0;
}
