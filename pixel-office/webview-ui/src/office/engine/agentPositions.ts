/**
 * Remembers where each agent stands so a page refresh puts everyone back where
 * they were instead of re-spawning them at their seats / one start point.
 * Tile-based (not pixel) so it survives sprite/zoom changes. Browser-local.
 */
export const AGENT_POSITIONS_KEY = 'pixelAgents.agentPositions';

export interface SavedTile {
  col: number;
  row: number;
}
export type SavedPositions = Record<string, SavedTile>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAgentPositions(storage: StorageLike | null = defaultStorage()): SavedPositions {
  if (!storage) return {};
  try {
    const raw = JSON.parse(storage.getItem(AGENT_POSITIONS_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: SavedPositions = {};
    for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
      const tile = t as Partial<SavedTile> | null;
      if (tile && Number.isInteger(tile.col) && Number.isInteger(tile.row)) {
        out[id] = { col: tile.col as number, row: tile.row as number };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAgentPositions(
  characters: Iterable<{ id: number; tileCol: number; tileRow: number; isSubagent?: boolean; matrixEffect?: unknown }>,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const out: SavedPositions = {};
  for (const ch of characters) {
    if (ch.id < 0 || ch.isSubagent || ch.matrixEffect) continue;
    out[String(ch.id)] = { col: ch.tileCol, row: ch.tileRow };
  }
  try {
    storage.setItem(AGENT_POSITIONS_KEY, JSON.stringify(out));
  } catch {
    /* quota / private mode — positions just won't persist */
  }
}
