/** Magic numbers and colours for the 3D office. Colours are 0xRRGGBB numbers (the repo lint bans colour strings). */
export const WALK_SPEED = 2.6;
export const SPRINT_MULT = 1.8;
export const ACCEL = 14;
export const MOUSE_SENS = 0.0022;
export const PITCH_LIMIT = 1.35;
export const FOV = 70;
export const NEAR = 0.05;
export const FAR = 120;
export const MAX_PIXEL_RATIO = 2;
export const MAX_FRAME_DT = 0.1;
export const BOB_AMOUNT = 0.025;
export const BOB_SPEED = 9;
export const SCREEN_W = 480;
export const SCREEN_H = 300;
/** Seated agents' name tags sit above the monitor so they never cover the screen text. */
export const SEATED_LABEL_Y = 2.05;
export const SCREEN_REFRESH_MS = 1000;
export const MINIMAP_REFRESH_MS = 100;
export const INTRO_SECONDS = 1.4;
export const INTRO_HEIGHT = 14;
export const TALK_RANGE = 2.2;
/** Creative-style flying (F): vertical speed, ceiling for the camera, and how fast it drops back when landing. */
export const FLY_VSPEED = 3.2;
export const FLY_MAX_HEIGHT = 14;
export const FLY_LAND_SPEED = 6;
/** Pixels per floor tile / wall face in the baked textures (matches the 2D 16px tiles). */
export const TILE_PX = 16;
/** Billboard size in metres for a 16x32 pixel character. */
export const CHAR_W = 0.8;
export const CHAR_H = 1.6;
export const CHAR_SEATED_DROP = 0.25;
export const CHAR_FRAME_SECONDS = 0.25;
export const LABEL_FONT = '"FS Pixel Sans", monospace';
export { FLOOR_SEAM, FLOOR_SPECK_DARK, FLOOR_SPECK_LIGHT } from '../constants.js';
export const FLOOR_FALLBACK = 0x6a5f55;
/** Face shading so flat pixel props still read as volumes without smooth lighting. */
export const SHADE = { top: 1, front: 0.82, side: 0.66 };

export const COL = {
  sky: 0x1e1e2e,
  wallPx: 0x3a3a5c,
  wallPxHi: 0x4b4b75,
  wallPxLo: 0x2c2c47,
  border: 0x4a4a6a,
  ink: 0x0a0a14,
  floorA: 0xb9a98f,
  floorB: 0xa89878,
  carpet: 0x4b5f86,
  wall: 0xd8d4cc,
  wallTop: 0x8e8a82,
  ceiling: 0xececea,
  lamp: 0xfff6dc,
  skin: [0xf1c9a5, 0xe0ac82, 0xc68a5f, 0x8f5d3b, 0xf4d7bb, 0xd79b73],
  shirt: [0x4f7cd9, 0xd95f5f, 0x5fb36b, 0xe0a93d, 0x9b6bd1, 0x47b5b5],
  pants: 0x2c2f45,
  screenBg: 0x0e1424,
  screenBar: 0x1d2b52,
  screenText: 0xcfe3ff,
  screenDim: 0x7f93b8,
  working: 0x4ade80,
  idle: 0x9aa3b5,
  blocked: 0xf59e0b,
  labelBg: 0x0e1424,
  labelText: 0xffffff,
  labelSub: 0xb7c4de,
  mapBg: 0x0e1424,
  mapWall: 0x8e8a82,
  mapFloor: 0x3a4260,
  mapDesk: 0x6b5a40,
  mapAgent: 0x4ade80,
  mapMe: 0xffd24a,
};

/** 0xRRGGBB → '#rrggbb' for canvas/CSS use. */
export function css(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}
export const FALLBACK_COLOR = 0x8a8a96;

/** Hover overview: camera height (m) and downward tilt (rad). */
export const HOVER_HEIGHT = 11;
export const HOVER_PITCH = 1.1;
