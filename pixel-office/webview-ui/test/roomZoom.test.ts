import { describe, expect, it } from 'vitest';

import { loadAgentPositions, saveAgentPositions } from '../src/office/engine/agentPositions.js';
import { fitRoom, roomAt } from '../src/office/engine/roomZoom.js';

const layout = {
  cols: 4,
  rows: 2,
  areaTiles: ['A', 'A', null, 'B', 'A', 'A', null, 'B'] as Array<string | null>,
};

describe('roomZoom', () => {
  it('finds the room bounds from any tile in it', () => {
    expect(roomAt(layout, 1, 1)).toEqual({ label: 'A', minCol: 0, minRow: 0, maxCol: 1, maxRow: 1 });
    expect(roomAt(layout, 2, 0)).toBeNull();
    expect(roomAt(layout, 9, 9)).toBeNull();
  });
  it('centers the pan on the room', () => {
    const room = roomAt(layout, 3, 0)!;
    const { zoom, pan } = fitRoom(room, layout, 160, 160);
    expect(zoom).toBeGreaterThanOrEqual(1);
    expect(pan.x).toBeLessThan(0); // room B is right of center (camera-follow sign)
    expect(pan.y).toBe(0);
  });
});

describe('agentPositions', () => {
  it('round-trips and skips sub-agents', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveAgentPositions(
      [
        { id: 1, tileCol: 3, tileRow: 4 },
        { id: -1, tileCol: 1, tileRow: 1 },
      ],
      s,
    );
    expect(loadAgentPositions(s)).toEqual({ '1': { col: 3, row: 4 } });
    store.set('pixelAgents.agentPositions', 'garbage');
    expect(loadAgentPositions(s)).toEqual({});
  });
});
