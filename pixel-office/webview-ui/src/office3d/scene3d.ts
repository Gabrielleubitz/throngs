/** The three.js office: builds the scene from a World3D + agents, runs walking, screens and proximity. */
import * as THREE from 'three';

import { getCharacterSprites } from '../office/sprites/spriteData.js';
import type { SpriteData } from '../office/types.js';
import { getWallInstances, hasWallSprites } from '../office/wallTiles.js';
import { trembleOffset } from '../sm/voiceLevel.js';
import { type Agent3D, type Pet3D, pickTalkTarget, screenKey, wrapText } from './agents3d.js';
import {
  ACCEL, BOB_AMOUNT, BOB_SPEED, CHAR_FRAME_SECONDS, CHAR_H, CHAR_SEATED_DROP, CHAR_W, COL, css, FAR, FLY_LAND_SPEED, FLY_MAX_HEIGHT, FLY_VSPEED, FOV, HOVER_HEIGHT, HOVER_PITCH, INTRO_HEIGHT,
  INTRO_SECONDS, LABEL_FONT, MAX_FRAME_DT, MAX_PIXEL_RATIO, MINIMAP_REFRESH_MS, MOUSE_SENS, NEAR, PITCH_LIMIT, SCREEN_H,
  SCREEN_REFRESH_MS, SCREEN_W, SEATED_LABEL_Y, SHADE, SPRINT_MULT, TALK_RANGE, TILE_PX, WALK_SPEED,
} from './constants3d.js';
import { type Box3, EYE_HEIGHT, moveWithCollision, nearestFree, TILE_M, WALL_HEIGHT, type World3D } from './layout3d.js';

/** One sprite pixel of furniture = one cube this big (16 pixels per tile, like the 2D office). */
const PROP_PX = TILE_M / 16;
/** One character pixel (a 16x32 sprite drawn CHAR_W wide). */
const CHAR_PX = CHAR_W / 16;
const WALL_ART_DEPTH = PROP_PX;
import { zooAnimalFrames } from '../office/sprites/zooAnimals.js';
import { bbox, furniture, hull, lathe, meshGrid, modelKindFor } from './models3d.js';
import { floorCanvas, pixelTexture, spriteCanvas, wallCanvas } from './pixelTextures.js';
import { buildVoxels, type VoxelOpts } from './pixelVoxels.js';

export interface StartPose {
  /** World metres. */
  x: number;
  z: number;
  /** Radians; 0 faces north (-z). */
  yaw?: number;
}

export interface SceneCallbacks {
  onTalkTarget: (agent: Agent3D | null) => void;
  onExit: () => void;
  onLockChange: (locked: boolean) => void;
  /** Click on something in the world (the crosshair when the mouse is captured, the pointer when it is free). */
  onPick?: (pick: ScenePick) => void;
  /** Tab: the mouse is freed (true) or captured again (false). */
  onFreeChange?: (free: boolean) => void;
}

export type ScenePick =
  | { kind: 'agent'; id: number }
  | { kind: 'pet'; id: string }
  | { kind: 'furniture'; type: string; uid: string };

interface ScreenRec {
  agentId: number;
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  key: string;
}
interface MonitorRec { group: THREE.Group; desk: Box3; tex: THREE.CanvasTexture; home: { x: number; z: number } }
interface PetRec { group: THREE.Group; body: THREE.Mesh; kind: number; phase: number; tx: number; tz: number }
interface Figure { group: THREE.Group; label: THREE.Sprite; body: THREE.Mesh; agent: Agent3D; agentId: number; phase: number }

/** Office Direction values: 0 down, 1 left, 2 right, 3 up → facing vector on the floor plane (x east, z south). */
const FACING: Array<[number, number]> = [[0, 1], [-1, 0], [1, 0], [0, -1]];

/** Which of the four 2D sprite directions a viewer at (vx, vz) relative to the agent should see. */
export function spriteDirFor(facing: number, vx: number, vz: number): 0 | 1 | 2 | 3 {
  const len = Math.hypot(vx, vz) || 1;
  const nx = vx / len, nz = vz / len;
  const [fx, fz] = FACING[facing] ?? FACING[0]!;
  const toward = fx * nx + fz * nz;
  if (toward > 0.7) return 0;
  if (toward < -0.7) return 3;
  return fx * nz + fz * -nx > 0 ? 2 : 1;
}

function hex(c: string | number): THREE.Color { return new THREE.Color(c); }

function paintScreen(rec: ScreenRec, a: Agent3D): void {
  const g = rec.ctx;
  g.fillStyle = css(COL.screenBg); g.fillRect(0, 0, SCREEN_W, SCREEN_H);
  g.fillStyle = css(COL.screenBar); g.fillRect(0, 0, SCREEN_W, 40);
  const dot = css(a.state === 'WORKING' ? COL.working : a.state === 'BLOCKED' ? COL.blocked : COL.idle);
  g.fillStyle = dot; g.fillRect(14, 12, 16, 16);
  g.fillStyle = css(COL.screenText); g.font = `bold 24px ${LABEL_FONT}`; g.textBaseline = 'middle';
  g.fillText(`${a.name} · ${a.state}`, 42, 21);
  g.textBaseline = 'alphabetic';
  g.font = `bold 30px ${LABEL_FONT}`;
  let y = 80;
  const task = a.task || (a.state === 'IDLE' ? 'Waiting for work' : 'Working');
  for (const line of wrapText(task, 26, 4)) { g.fillStyle = css(COL.screenText); g.fillText(line, 18, y); y += 36; }
  if (a.lastAction) {
    y += 12; g.font = `18px ${LABEL_FONT}`; g.fillStyle = css(COL.screenDim);
    for (const line of wrapText(`> ${a.lastAction}`, 40, 3)) { g.fillText(line, 18, y); y += 24; }
  }
  rec.tex.needsUpdate = true;
}

function makeLabel(name: string, role: string): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 128; c.height = 36;
  const g = c.getContext('2d')!;
  g.fillStyle = css(COL.border); g.fillRect(0, 0, 128, 36);
  g.fillStyle = css(COL.sky); g.fillRect(2, 2, 124, 32);
  g.textAlign = 'center'; g.fillStyle = css(COL.labelText); g.font = `bold 14px ${LABEL_FONT}`;
  g.fillText(name.slice(0, 14), 64, 15);
  g.fillStyle = css(COL.labelSub); g.font = `10px ${LABEL_FONT}`; g.fillText(role.slice(0, 22), 64, 28);
  const tex = pixelTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(1.0, 0.28, 1);
  return s;
}

export class OfficeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  private ceiling: THREE.Object3D | null = null;
  private figures = new Map<number, Figure>();
  private pets = new Map<string, PetRec>();
  private screens = new Map<number, ScreenRec>();
  private monitors = new Map<number, MonitorRec>();
  private agents: Agent3D[] = [];
  private keys = new Set<string>();
  private pos = { x: 1.5, z: 1.5 };
  private vel = { x: 0, z: 0 };
  private yaw = 0;
  private pitch = 0;
  private bob = 0;
  /** Flying (F): the camera's height above the floor; free over the walls once above them. */
  private flying = false;
  private height = EYE_HEIGHT;
  /** Hover (H): glide up above the roofs and tilt down for an overview; WASD still pans. */
  private hoverGoal: { height: number } | null = null;
  /** Pitch eased toward on hover/land; any mouse-look drops it so the user's own pitch wins. */
  private pitchGoal: number | null = null;
  private locked = false;
  private paused = false;
  private dragging = false;
  private lockFailed = false;
  private lastMouse: { x: number; y: number } | null = null;
  /** Tab: mouse free to click the world and the HUD; drag still looks around. */
  private free = false;
  private softRelease = false;
  private downAt: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private introT = 0;
  private introFrom = { x: 0, z: 0 };
  private lastTarget: Agent3D | null = null;
  private lastScreenCheck = 0;
  private lastMap = 0;
  private disposed = false;
  private last = 0;
  private minimap: HTMLCanvasElement | null = null;
  private resizeObs: ResizeObserver;
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private texs: THREE.Texture[] = [];
  private cleanups: Array<() => void> = [];
  /** Pixel-voxel meshes are cached per sprite (+ options): the same furniture type / animation frame is built once. */
  private modelCache = new Map<string, THREE.BufferGeometry>();
  private spriteIds = new WeakMap<SpriteData, number>();
  private nextSpriteId = 0;
  private allVox: THREE.BufferGeometry[] = [];
  private voxMat = new THREE.MeshBasicMaterial({ vertexColors: true });

  private host: HTMLElement;
  private world: World3D;
  private cb: SceneCallbacks;

  constructor(host: HTMLElement, world: World3D, cb: SceneCallbacks) {
    this.host = host; this.world = world; this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.tabIndex = 0;
    this.scene.background = hex(COL.sky);
    this.scene.fog = new THREE.Fog(COL.sky, 18, 60);
    this.buildStatic();
    this.camera.rotation.order = 'YXZ';
    this.bind();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
  }

  setMinimap(c: HTMLCanvasElement | null): void { this.minimap = c; }
  getPose(): { x: number; z: number; yaw: number } { return { x: this.pos.x, z: this.pos.z, yaw: this.yaw }; }

  /** Begin (or restart) the walk at a pose, flying down from above when `intro` is set. */
  start(pose: StartPose, intro = true): void {
    const free = nearestFree(this.world, pose.x, pose.z) ?? { x: TILE_M * 1.5, z: TILE_M * 1.5 };
    this.pos = { ...free };
    this.yaw = pose.yaw ?? 0;
    this.pitch = 0;
    this.introFrom = { x: pose.x, z: pose.z };
    this.introT = intro ? 0 : INTRO_SECONDS;
    if (this.ceiling) this.ceiling.visible = !intro;
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.keys.clear();
    if (p && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  isFree(): boolean { return this.free; }

  /** Free the mouse (to click the world and the HUD) or capture it for walking again. */
  setFree(on: boolean): void {
    if (on === this.free) return;
    this.free = on;
    this.dragging = false;
    if (on && document.pointerLockElement === this.renderer.domElement) { this.softRelease = true; document.exitPointerLock(); }
    if (!on) this.requestLock();
    this.cb.onFreeChange?.(on);
  }

  /** What is under a screen point (normalised -1..1): a person, an animal or a piece of furniture, unless a wall is in front. */
  private pickAt(nx: number, ny: number): ScenePick | null {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    for (const hit of this.raycaster.intersectObjects(this.scene.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      if (o instanceof THREE.Sprite || o.visible === false) continue;
      while (o) {
        const u = o.userData as { pickAgent?: number; pickPet?: string; pickFurn?: { type: string; uid: string } };
        if (u.pickAgent !== undefined) return { kind: 'agent', id: u.pickAgent };
        if (u.pickPet !== undefined) return { kind: 'pet', id: u.pickPet };
        if (u.pickFurn) return { kind: 'furniture', ...u.pickFurn };
        o = o.parent;
      }
      return null; // the first thing hit is a wall, floor or the like
    }
    return null;
  }

  requestLock(): void {
    if (this.free) return;
    const el = this.renderer.domElement;
    if (typeof el.requestPointerLock !== 'function') { this.lockFailed = true; return; }
    // Some shells (the Mac app's webview) refuse pointer lock: remember it so drag-look and click-to-pick take over.
    try { void Promise.resolve(el.requestPointerLock()).catch(() => { this.lockFailed = true; }); } catch { this.lockFailed = true; }
  }

  setAgents(agents: Agent3D[]): void {
    this.agents = agents;
    const seen = new Set<number>();
    for (const a of agents) {
      seen.add(a.id);
      let f = this.figures.get(a.id);
      if (!f) { f = this.makeFigure(a); this.figures.set(a.id, f); }
      f.agent = a;
      this.syncMonitor(a);
      if (!f.group.userData['placed']) { f.group.position.set(a.x, 0, a.z); f.group.userData['placed'] = true; }
      f.group.userData['tx'] = a.x; f.group.userData['tz'] = a.z;
    }
    for (const [id, f] of this.figures) {
      if (seen.has(id)) continue;
      this.scene.remove(f.group); this.figures.delete(id);
      this.removeMonitor(id);
    }
    this.lastScreenCheck = 0;
  }

  /** Zoo animals: voxel models of their side-view sprites that walk about and turn the way they go. */
  setPets(pets: Pet3D[]): void {
    const seen = new Set<string>();
    for (const p of pets) {
      const fr = zooAnimalFrames(p.kind);
      if (!fr) continue;
      seen.add(p.id);
      let r = this.pets.get(p.id);
      if (!r) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(undefined, this.voxMat);
        g.add(body);
        const label = makeLabel(p.name.split(' the ')[0] ?? p.name, p.name.includes(' the ') ? p.name.split(' the ')[1]! : 'Zoo');
        this.texs.push((label.material as THREE.SpriteMaterial).map!); this.mats.push(label.material);
        label.position.y = 0.95;
        g.add(label);
        g.position.set(p.x, 0, p.z);
        g.userData.pickPet = p.id;
        this.scene.add(g);
        r = { group: g, body, kind: p.kind, phase: Math.random(), tx: p.x, tz: p.z };
        this.pets.set(p.id, r);
      }
      r.tx = p.x; r.tz = p.z;
    }
    for (const [id, r] of this.pets) {
      if (seen.has(id)) continue;
      this.scene.remove(r.group); this.pets.delete(id);
    }
  }

  private posePets(dt: number, now: number): void {
    for (const r of this.pets.values()) {
      const dx = r.tx - r.group.position.x, dz = r.tz - r.group.position.z;
      const moving = Math.hypot(dx, dz) > 0.03;
      const k = Math.min(1, dt * 6);
      r.group.position.x += dx * k; r.group.position.z += dz * k;
      const fr = zooAnimalFrames(r.kind);
      if (!fr) continue;
      const step = moving && Math.floor(now / 200 + r.phase * 4) % 2 === 1 ? 1 : 0;
      const geo = this.voxels(fr[step]!, { mode: 'upright', px: PROP_PX, depth: PROP_PX * 5 });
      if (r.body.geometry !== geo) r.body.geometry = geo;
      if (moving) r.body.rotation.y = Math.atan2(-dz, dx); // sprite faces +x
    }
  }

  // ── scene construction ──────────────────────────────────────────
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geoms.push(g); return g; }
  private mat<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }

  private buildStatic(): void {
    const { cols, rows } = this.world;

    // Floor: the 2D floor tiles, one 16px block per tile, nearest-neighbour.
    const ftex = pixelTexture(floorCanvas(cols, rows, this.world.tiles, this.world.tileColors)); this.texs.push(ftex);
    const floor = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(cols, rows)), this.mat(new THREE.MeshBasicMaterial({ map: ftex, transparent: true, alphaTest: 0.01 })));
    floor.rotation.x = -Math.PI / 2; floor.position.set(cols / 2, 0, rows / 2);
    this.scene.add(floor);
    // Void tiles are transparent in the floor texture; a dark ground plane sits under them.
    const ground = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(cols * 3, rows * 3)), this.mat(new THREE.MeshBasicMaterial({ color: COL.sky })));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cols / 2, -0.02, rows / 2);
    this.scene.add(ground);

    // Walls: one instanced mesh, pixel brick face on the sides, flat lit cap on top.
    const wallIdx: number[] = [];
    this.world.wall.forEach((w, i) => { if (w) wallIdx.push(i); });
    if (wallIdx.length) {
      // Same auto-tiled, colourised wall sprites the 2D renderer draws; one instanced mesh per distinct sprite.
      const groups = new Map<SpriteData | null, number[]>();
      const tileRows: number[][] = [];
      for (let r = 0; r < rows; r++) tileRows.push(this.world.tiles.slice(r * cols, (r + 1) * cols));
      const bySprite = new Map<number, SpriteData>();
      if (hasWallSprites()) {
        for (const w of getWallInstances(tileRows as never, this.world.tileColors, cols)) {
          bySprite.set((Math.round(w.zY / TILE_PX) - 1) * cols + Math.round(w.x / TILE_PX), w.sprite);
        }
      }
      for (const i of wallIdx) {
        const s = bySprite.get(i) ?? null;
        const list = groups.get(s); if (list) list.push(i); else groups.set(s, [i]);
      }
      const top = this.mat(new THREE.MeshBasicMaterial({ color: COL.wallPxHi }));
      const bottom = this.mat(new THREE.MeshBasicMaterial({ color: COL.ink }));
      const m = new THREE.Matrix4();
      for (const [sprite, idxs] of groups) {
        const wtex = pixelTexture(sprite ? spriteCanvas(sprite) : wallCanvas()); this.texs.push(wtex);
        const side = (k: number) => this.mat(new THREE.MeshBasicMaterial({ map: wtex, color: new THREE.Color(k, k, k) }));
        const mats = [side(SHADE.side), side(SHADE.side), top, bottom, side(SHADE.front), side(SHADE.front)];
        const wm = new THREE.InstancedMesh(this.geo(new THREE.BoxGeometry(TILE_M, WALL_HEIGHT, TILE_M)), mats, idxs.length);
        idxs.forEach((i, n) => { m.setPosition((i % cols) + 0.5, WALL_HEIGHT / 2, Math.floor(i / cols) + 0.5); wm.setMatrixAt(n, m); });
        this.scene.add(wm);
      }
    }

    // Ceiling with lamp panels, hidden during the fly-in.
    const ceiling = new THREE.Group();
    const plane = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(cols, rows)), this.mat(new THREE.MeshBasicMaterial({ color: COL.wallPxLo, side: THREE.BackSide })));
    plane.rotation.x = -Math.PI / 2; plane.position.set(cols / 2, WALL_HEIGHT, rows / 2);
    ceiling.add(plane);
    // Glowstone-style lamp blocks with a bright core and darker rim.
    const lampGeo = this.geo(new THREE.BoxGeometry(1.0, 0.12, 0.5));
    const lampMat = this.mat(new THREE.MeshBasicMaterial({ color: COL.lamp }));
    for (let r = 2; r < rows; r += 4) for (let c = 2; c < cols; c += 4) {
      if (!this.world.floor[r * cols + c]) continue;
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(c + 0.5, WALL_HEIGHT - 0.06, r + 0.5);
      ceiling.add(lamp);
    }
    this.ceiling = ceiling;
    this.scene.add(ceiling);

    // Furniture.
    for (const b of this.world.boxes) this.addBox(b);
  }

  /** Cache a built voxel mesh under a key (geometry is shared by every copy of the same item / frame). */
  private cached(key: string, build: () => { positions: Float32Array; colors: Float32Array }): THREE.BufferGeometry {
    let g = this.modelCache.get(key);
    if (!g) {
      const v = build();
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(v.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(v.colors, 3));
      this.modelCache.set(key, g); this.allVox.push(g);
    }
    return g;
  }
  private spriteKey(s: SpriteData): number {
    let k = this.spriteIds.get(s);
    if (k === undefined) { k = ++this.nextSpriteId; this.spriteIds.set(s, k); }
    return k;
  }
  /** The flat tiny-cube version of a sprite (fallback, and wall art). */
  private voxels(sprite: SpriteData, opts: VoxelOpts): THREE.BufferGeometry {
    return this.cached(`v${this.spriteKey(sprite)}:${JSON.stringify(opts)}`, () => buildVoxels(sprite, opts));
  }

  /**
   * A prop as a real 3D pixel model you can walk around (models3d.ts): round things are spun, furniture is
   * built from parts in the sprite's own colours, and anything without a model falls back to the flat version.
   */
  private addBox(b: Box3): void {
    const cx = b.x + b.w / 2;
    if (!b.sprite || !b.sprite.length) {
      const base = hex(b.color);
      const mats = [SHADE.side, SHADE.side, SHADE.top, SHADE.side, SHADE.front, SHADE.front].map((k) => this.mat(new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(k) })));
      const mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(b.w * 0.96, b.h, b.d * 0.96)), mats);
      mesh.position.set(cx, b.y + b.h / 2, b.z + b.d / 2);
      mesh.userData.pickFurn = { type: b.type, uid: b.uid };
      this.scene.add(mesh);
      return;
    }
    const sprite = b.sprite;
    const rows = sprite.length;
    let mesh: THREE.Mesh;
    if (b.kind === 'wall-art') {
      // hung on the ROOM side (south face) of the wall tile it belongs to, centred around eye level
      const r = b.wallRow ?? Math.floor(b.z / TILE_M), c = Math.floor(b.x / TILE_M);
      const onWall = this.world.wall[r * this.world.cols + c] === true;
      const h = rows * PROP_PX;
      mesh = new THREE.Mesh(this.voxels(sprite, { mode: 'upright', px: PROP_PX, depth: WALL_ART_DEPTH }), this.voxMat);
      mesh.position.set(cx, Math.max(0.3, Math.min(1.55 - h / 2, WALL_HEIGHT - h - 0.05)), (onWall ? r + 1 : r + 0.5) * TILE_M + WALL_ART_DEPTH / 2 + 0.005);
      mesh.userData.pickFurn = { type: b.type, uid: b.uid };
      this.scene.add(mesh);
      return;
    }
    const kind = modelKindFor(b.type);
    const foot = Math.min(b.d, TILE_M);
    if (kind === 'round') {
      mesh = new THREE.Mesh(this.cached(`l${this.spriteKey(sprite)}`, () => meshGrid(lathe(sprite), PROP_PX)), this.voxMat);
      // desk-top items keep their spot on the tile (a cup drawn at the back of its tile sits at the back)
      const bb = bbox(sprite);
      const z = b.y > 0 && bb ? b.z + ((bb.y0 + bb.y1 + 1) / 2 / rows) * b.d : b.z + b.d - foot / 2;
      mesh.position.set(cx, b.y, z);
    } else if (kind) {
      // side-facing items are the same model turned 90° (":left" variants face the other way); back = turned 180°
      const side = b.orientation === 'side' || b.orientation === 'left' || b.orientation === 'right';
      const left = side && (b.type.endsWith(':left') || b.orientation === 'left');
      const w = Math.round((side ? b.d : b.w) * 16), d = Math.round((side ? b.w : b.d) * 16);
      const h = kind === 'shelf' || kind === 'board' ? rows : Math.round(b.h * 16);
      mesh = new THREE.Mesh(this.cached(`m${kind}:${this.spriteKey(sprite)}:${w}x${d}x${h}`, () => meshGrid(furniture(kind, sprite, w, d, h), PROP_PX)), this.voxMat);
      mesh.rotation.y = side ? (left ? -Math.PI / 2 : Math.PI / 2) : b.orientation === 'back' ? Math.PI : 0;
      mesh.position.set(cx, b.y, b.z + b.d / 2);
    } else if (b.kind === 'desk') {
      mesh = new THREE.Mesh(this.voxels(sprite, { mode: 'fold', px: PROP_PX, depth: b.d * 0.96, frontRows: Math.round(b.h / PROP_PX) }), this.voxMat);
      mesh.position.set(cx, b.y, b.z + b.d / 2);
    } else {
      mesh = new THREE.Mesh(this.voxels(sprite, { mode: 'upright', px: PROP_PX, depth: foot * 0.8 }), this.voxMat);
      mesh.position.set(cx, b.y, b.z + b.d - foot / 2);
    }
    mesh.userData.pickFurn = { type: b.type, uid: b.uid };
    this.scene.add(mesh);
  }

  /** The same layered 2D character (hair, outfit, hat, accessory, tune) as a real 3D figure carved from its front, back and side drawings. */
  private makeFigure(a: Agent3D): Figure {
    const g = new THREE.Group();
    const body = new THREE.Mesh(undefined, this.voxMat);
    g.add(body);
    const label = makeLabel(a.name, a.role);
    this.texs.push((label.material as THREE.SpriteMaterial).map!); this.mats.push(label.material);
    g.add(label);
    this.scene.add(g);
    g.userData.pickAgent = a.id;
    const f: Figure = { group: g, label, body, agent: a, agentId: a.id, phase: Math.random() };
    this.poseFigure(f, 0);
    return f;
  }

  private poseFigure(f: Figure, now: number): void {
    const a = f.agent;
    const set = getCharacterSprites(a.palette, a.hueShift, a.tune, a.look);
    const u = f.group.userData as { tx?: number; tz?: number };
    const dx = (u.tx ?? 0) - f.group.position.x, dz = (u.tz ?? 0) - f.group.position.z;
    const moving = Math.hypot(dx, dz) > 0.05;
    const tick = Math.floor(now / 1000 / CHAR_FRAME_SECONDS + f.phase * 4);
    // front = facing-down drawing, back = facing-up, side = facing-right (left is its mirror)
    const anim = moving ? set.walk : a.seated ? set.typing : null;
    const n = anim ? anim[0].length : 1;
    const i = anim ? tick % n : 1;
    const pick = (d: 0 | 2 | 3) => (anim ? anim[d][i]! : set.walk[d][1]);
    const fr = pick(0), bk = pick(3), sd = pick(2);
    const geo = this.cached(`h${this.spriteKey(fr)}:${this.spriteKey(bk)}:${this.spriteKey(sd)}`, () => meshGrid(hull(fr, bk, sd), CHAR_PX));
    if (f.body.geometry !== geo) f.body.geometry = geo;
    // turn to where they walk, else the way they face in 2D
    const [fx, fz] = moving ? [dx, dz] : FACING[a.dir] ?? FACING[0]!;
    f.body.rotation.y = Math.atan2(fx, fz);
    const drop = a.seated && !moving ? CHAR_SEATED_DROP : 0;
    f.body.position.y = -drop;
    f.label.position.y = a.seated ? Math.max(CHAR_H + 0.2 - drop, SEATED_LABEL_Y) : CHAR_H + 0.2;
  }

  /**
   * Keeps one monitor per agent tied to a desk. A seated agent re-anchors to the desk they sit at;
   * a standing one keeps the last desk, or claims the nearest desk no other agent's monitor uses.
   */
  private syncMonitor(a: Agent3D): void {
    const cur = this.monitors.get(a.id);
    let desk: Box3 | null = null;
    let home = cur?.home ?? null;
    if (a.seated) {
      desk = this.nearestDesk(a.x, a.z, 3.5, a.id);
      if (desk) home = { x: a.x, z: a.z };
    }
    desk ??= cur?.desk ?? this.nearestDesk(a.x, a.z, Infinity, a.id);
    if (!desk) return;
    home ??= { x: a.x, z: a.z };
    if (cur && cur.desk === desk && cur.home.x === home.x && cur.home.z === home.z) return;
    this.removeMonitor(a.id);
    this.addMonitor(a, desk, home);
  }

  private nearestDesk(x: number, z: number, maxDist: number, selfId: number): Box3 | null {
    const taken = new Set<Box3>();
    for (const [id, m] of this.monitors) if (id !== selfId) taken.add(m.desk);
    let desk: Box3 | null = null, best = maxDist;
    for (const b of this.world.boxes) {
      if (b.kind !== 'desk') continue;
      const d = Math.hypot(b.x + b.w / 2 - x, b.z + b.d / 2 - z) + (taken.has(b) ? 100 : 0);
      if (d <= best || (maxDist === Infinity && !desk)) { best = d; desk = b; }
    }
    return desk;
  }

  private removeMonitor(id: number): void {
    const m = this.monitors.get(id);
    if (!m) return;
    this.scene.remove(m.group);
    m.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
    });
    m.tex.dispose();
    this.monitors.delete(id);
    this.screens.delete(id);
  }

  /** A monitor on the desk, turned toward the seat, showing a live canvas texture. */
  private addMonitor(a: Agent3D, desk: Box3, home: { x: number; z: number }): void {
    const px = Math.min(desk.x + desk.w - 0.2, Math.max(desk.x + 0.2, home.x));
    const pz = Math.min(desk.z + desk.d - 0.2, Math.max(desk.z + 0.2, home.z));
    const cv = document.createElement('canvas'); cv.width = SCREEN_W; cv.height = SCREEN_H;
    const tex = pixelTexture(cv);
    const rec: ScreenRec = { agentId: a.id, tex, ctx: cv.getContext('2d')!, key: '' };
    this.screens.set(a.id, rec);
    const mon = new THREE.Group();
    const dark = new THREE.MeshBasicMaterial({ color: COL.ink });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.75, 0.04), dark);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.14, 0.71), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.z = 0.021; face.name = 'screen';
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.35, 0.08), dark);
    stand.position.y = -0.55;
    mon.add(frame, face, stand);
    mon.position.set(px, 0.75 + 0.7, pz);
    mon.lookAt(home.x, mon.position.y, home.z);
    this.scene.add(mon);
    this.monitors.set(a.id, { group: mon, desk, tex, home });
  }

  // ── input ───────────────────────────────────────────────────────
  private on(t: EventTarget, ev: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(ev, fn as EventListener, opts);
    this.cleanups.push(() => t.removeEventListener(ev, fn as EventListener, opts));
  }

  private bind(): void {
    const el = this.renderer.domElement;
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if (this.paused) return;
      if (e.code === 'Escape') { this.cb.onExit(); return; }
      if (e.code === 'KeyH' && !e.repeat) { this.setHover(!this.hoverGoal); e.preventDefault(); return; }
      if (e.code === 'Tab' && !e.repeat) { this.setFree(!this.free); e.preventDefault(); return; }
      if (e.code === 'KeyF' && !e.repeat) { this.setFlying(!this.flying); e.preventDefault(); return; }
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'].includes(e.code)) e.preventDefault();
    });
    this.on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(document, 'pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === el;
      this.cb.onLockChange(this.locked);
      // Esc while locked releases the lock: treat as "leave" unless we paused for the chat.
      if (was && !this.locked && !this.paused && !this.disposed && !this.softRelease) this.cb.onExit();
      this.softRelease = false;
    });
    this.on(document, 'pointerlockerror', () => { this.lockFailed = true; });
    this.on(document, 'mousemove', (e: MouseEvent) => {
      const px = this.lastMouse, last = { x: e.clientX, y: e.clientY };
      this.lastMouse = last;
      if (this.paused || (!this.locked && !this.dragging)) return;
      // movementX is missing or zero in some webviews: fall back to the pointer's own travel.
      const mx = this.locked || (e.movementX ?? 0) !== 0 ? (e.movementX ?? 0) : px ? last.x - px.x : 0;
      const my = this.locked || (e.movementY ?? 0) !== 0 ? (e.movementY ?? 0) : px ? last.y - px.y : 0;
      this.pitchGoal = null;
      this.yaw -= mx * MOUSE_SENS;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - my * MOUSE_SENS));
    });
    this.on(el, 'mousedown', (e: MouseEvent) => {
      if (this.paused) return;
      this.dragging = true;
      this.downAt = { x: e.clientX, y: e.clientY };
      if (!this.locked && !this.free) this.requestLock();
    });
    this.on(window, 'mouseup', (e: MouseEvent) => {
      this.dragging = false;
      const d = this.downAt; this.downAt = null;
      // a click, not a look-drag: pick what is under the crosshair (locked) or the pointer (free)
      if (!d || this.paused || e.target !== el) return;
      if (e.button !== 0) return;
      if (!this.locked && !this.free && !this.lockFailed) return; // the click that only captures the mouse
      if (!this.locked && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const r = el.getBoundingClientRect();
      const pick = this.locked ? this.pickAt(0, 0) : this.pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      if (pick) this.cb.onPick?.(pick);
    });
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ── loop ────────────────────────────────────────────────────────
  private frame = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(MAX_FRAME_DT, (now - this.last) / 1000); this.last = now;
    if (this.introT < INTRO_SECONDS) this.intro(dt); else this.walk(dt);
    for (const f of this.figures.values()) {
      const u = f.group.userData as { tx: number; tz: number; trx?: number; trz?: number };
      const k = Math.min(1, dt * 6);
      const bx = f.group.position.x - (u.trx ?? 0), bz = f.group.position.z - (u.trz ?? 0); // strip last frame's tremble
      const nx = bx + (u.tx - bx) * k, nz = bz + (u.tz - bz) * k;
      const t = trembleOffset(f.agent.id, performance.now()); // owner is speaking: shake every frame
      u.trx = (t.dx / 16) * TILE_M; u.trz = (t.dy / 16) * TILE_M;
      f.group.position.x = nx + u.trx; f.group.position.z = nz + u.trz;
    }
    for (const f of this.figures.values()) this.poseFigure(f, now);
    this.posePets(dt, now);
    this.updateScreens(now);
    this.updateTarget();
    this.drawMinimap(now);
    this.renderer.render(this.scene, this.camera);
  };

  private intro(dt: number): void {
    this.introT = Math.min(INTRO_SECONDS, this.introT + dt);
    const t = this.introT / INTRO_SECONDS, e = t * t * (3 - 2 * t);
    const h = INTRO_HEIGHT + (EYE_HEIGHT - INTRO_HEIGHT) * e;
    this.camera.position.set(this.introFrom.x + (this.pos.x - this.introFrom.x) * e, h, this.pos.z + (1 - e) * 4);
    this.camera.rotation.set((-Math.PI / 2) * (1 - e) + this.pitch * e, this.yaw * e, 0);
    if (this.introT >= INTRO_SECONDS && this.ceiling) this.ceiling.visible = true;
  }

  /** Toggle creative-style flying. Landing drops you to the nearest free spot on the floor. */
  setFlying(on: boolean): void {
    this.flying = on;
    if (this.hoverGoal) this.pitchGoal = 0;
    this.hoverGoal = null;
    if (!on) { const free = nearestFree(this.world, this.pos.x, this.pos.z); if (free) this.pos = free; }
  }
  /** Hover over the office: fly up above the walls looking down; toggling off lands you again. */
  setHover(on: boolean): void {
    if (!on) { this.setFlying(false); return; }
    this.flying = true;
    this.hoverGoal = { height: HOVER_HEIGHT };
    this.pitchGoal = -HOVER_PITCH;
  }
  isHovering(): boolean { return this.hoverGoal !== null; }
  isFlying(): boolean { return this.flying; }

  private walk(dt: number): void {
    const k = this.keys;
    // height: fly up/down, or ease back to eye level after landing
    if (this.hoverGoal) {
      const a = Math.min(1, 3 * dt);
      this.height += (this.hoverGoal.height - this.height) * a;
      const v = (k.has('Space') ? 1 : 0) - (k.has('KeyC') || k.has('ControlLeft') ? 1 : 0);
      if (v) { this.hoverGoal.height = Math.max(WALL_HEIGHT + 1, Math.min(FLY_MAX_HEIGHT, this.hoverGoal.height + v * FLY_VSPEED * dt)); }
    } else if (this.flying) {
      const v = (k.has('Space') ? 1 : 0) - (k.has('KeyC') || k.has('ControlLeft') ? 1 : 0);
      this.height = Math.max(0.4, Math.min(FLY_MAX_HEIGHT, this.height + v * FLY_VSPEED * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2 : 1) * dt));
    } else if (this.height !== EYE_HEIGHT) {
      const step = FLY_LAND_SPEED * dt;
      this.height = Math.abs(this.height - EYE_HEIGHT) <= step ? EYE_HEIGHT : this.height + Math.sign(EYE_HEIGHT - this.height) * step;
    }
    if (this.pitchGoal !== null) {
      this.pitch += (this.pitchGoal - this.pitch) * Math.min(1, 3 * dt);
      if (Math.abs(this.pitchGoal - this.pitch) < 0.01) { this.pitch = this.pitchGoal; this.pitchGoal = null; }
    }
    const overWalls = this.height > WALL_HEIGHT + 0.2;
    if (this.ceiling) this.ceiling.visible = this.height < WALL_HEIGHT - 0.25;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') ? SPRINT_MULT : 1;
    const len = Math.hypot(f, s) || 1;
    const speed = WALK_SPEED * sprint;
    const tx = ((-Math.sin(this.yaw)) * f + Math.cos(this.yaw) * s) / len * speed;
    const tz = ((-Math.cos(this.yaw)) * f - Math.sin(this.yaw) * s) / len * speed;
    const a = Math.min(1, ACCEL * dt);
    this.vel.x += (tx - this.vel.x) * a; this.vel.z += (tz - this.vel.z) * a;
    const p = overWalls
      ? { x: Math.max(0, Math.min(this.world.cols, this.pos.x + this.vel.x * dt)), z: Math.max(0, Math.min(this.world.rows, this.pos.z + this.vel.z * dt)) }
      : moveWithCollision(this.world, this.pos.x, this.pos.z, this.vel.x * dt, this.vel.z * dt);
    const moved = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    this.pos = p;
    this.bob += moved * BOB_SPEED;
    const bob = this.flying ? 0 : Math.sin(this.bob) * BOB_AMOUNT * Math.min(1, moved / (dt * WALK_SPEED + 1e-6));
    this.camera.position.set(p.x, this.height + bob, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private updateScreens(now: number): void {
    if (now - this.lastScreenCheck < SCREEN_REFRESH_MS) return;
    this.lastScreenCheck = now;
    for (const a of this.agents) {
      const rec = this.screens.get(a.id);
      if (!rec) continue;
      const key = screenKey(a);
      if (key === rec.key) continue;
      rec.key = key; paintScreen(rec, a);
    }
  }

  private updateTarget(): void {
    const t = this.introT < INTRO_SECONDS ? null : pickTalkTarget(this.pos.x, this.pos.z, this.yaw, this.agents.filter((a) => a.crewId), TALK_RANGE);
    if (t?.id !== this.lastTarget?.id) { this.lastTarget = t; this.cb.onTalkTarget(t); }
  }

  getTalkTarget(): Agent3D | null { return this.lastTarget; }

  private drawMinimap(now: number): void {
    const c = this.minimap;
    if (!c || now - this.lastMap < MINIMAP_REFRESH_MS) return;
    this.lastMap = now;
    const g = c.getContext('2d'); if (!g) return;
    const { cols, rows } = this.world;
    const u = Math.min(c.width / cols, c.height / rows);
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = css(COL.mapBg); g.globalAlpha = 0.78; g.fillRect(0, 0, c.width, c.height); g.globalAlpha = 1;
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const i = r * cols + q;
      if (this.world.wall[i]) g.fillStyle = css(COL.mapWall);
      else if (this.world.blocked[i]) g.fillStyle = css(COL.mapDesk);
      else if (this.world.floor[i]) g.fillStyle = css(COL.mapFloor);
      else continue;
      g.fillRect(q * u, r * u, u, u);
    }
    g.fillStyle = css(COL.mapAgent);
    for (const a of this.agents) g.fillRect(a.x * u - 1.5, a.z * u - 1.5, 3, 3);
    g.fillStyle = css(COL.mapMe); g.beginPath();
    const mx = this.pos.x * u, mz = this.pos.z * u;
    g.moveTo(mx - Math.sin(this.yaw) * 6, mz - Math.cos(this.yaw) * 6);
    g.lineTo(mx - Math.cos(this.yaw) * 3 + Math.sin(this.yaw) * 3, mz + Math.sin(this.yaw) * 3 + Math.cos(this.yaw) * 3);
    g.lineTo(mx + Math.cos(this.yaw) * 3 + Math.sin(this.yaw) * 3, mz - Math.sin(this.yaw) * 3 + Math.cos(this.yaw) * 3);
    g.fill();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    for (const fn of this.cleanups) fn();
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.geoms.forEach((g) => g.dispose()); this.mats.forEach((m) => m.dispose()); this.texs.forEach((t) => t.dispose()); this.allVox.forEach((g) => g.dispose()); this.voxMat.dispose();
    this.screens.clear(); this.monitors.clear(); this.figures.clear(); this.pets.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
