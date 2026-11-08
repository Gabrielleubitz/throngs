/** Click-to-zoom on a room: pure geometry (bounds of an area label + a fitting zoom/pan). */
import { ZOOM_MAX, ZOOM_MIN } from '../../constants.js';
import { TILE_SIZE } from '../types.js';

export interface RoomBounds {
  label: string;
  minCol: number;
  minRow: number;
  maxCol: number;
  maxRow: number;
}

/** Room under a tile (its area label) and the bounding box of every tile with that label. */
export function roomAt(
  layout: { cols: number; rows: number; areaTiles?: Array<string | null> },
  col: number,
  row: number,
): RoomBounds | null {
  const tiles = layout.areaTiles;
  if (!tiles || col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
  const label = tiles[row * layout.cols + col];
  if (!label) return null;
  const b: RoomBounds = { label, minCol: col, minRow: row, maxCol: col, maxRow: row };
  tiles.forEach((l, i) => {
    if (l !== label) return;
    const c = i % layout.cols;
    const r = Math.floor(i / layout.cols);
    b.minCol = Math.min(b.minCol, c);
    b.maxCol = Math.max(b.maxCol, c);
    b.minRow = Math.min(b.minRow, r);
    b.maxRow = Math.max(b.maxRow, r);
  });
  return b;
}

/** Largest integer zoom that fits the room in the canvas (device px), and the pan that centers it. */
export function fitRoom(
  room: RoomBounds,
  layout: { cols: number; rows: number },
  canvasW: number,
  canvasH: number,
): { zoom: number; pan: { x: number; y: number } } {
  const wTiles = room.maxCol - room.minCol + 1;
  const hTiles = room.maxRow - room.minRow + 1;
  const fit = Math.floor(Math.min(canvasW / (wTiles * TILE_SIZE), canvasH / (hTiles * TILE_SIZE)));
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
  const cx = ((room.minCol + room.maxCol + 1) / 2) * TILE_SIZE;
  const cy = ((room.minRow + room.maxRow + 1) / 2) * TILE_SIZE;
  return {
    zoom,
    pan: {
      x: (layout.cols * TILE_SIZE * zoom) / 2 - cx * zoom,
      y: (layout.rows * TILE_SIZE * zoom) / 2 - cy * zoom,
    },
  };
}
