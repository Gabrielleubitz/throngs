import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  SM_DANCE_BPM,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { isDragged } from '../../sm/dragState.js';
import { isVoiceActive } from '../../sm/voiceLevel.js';
import { findPath } from '../layout/tileMap.js';
import { getHandsUpSprite } from '../sprites/handsUpSprite.js';
import type { CharacterSprites } from '../sprites/spriteData.js';
import { isReadingToolName } from '../toolUtils.js';
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';

/** Whether a tool should show the reading animation (vs typing). Taxonomy comes
 *  from the active HookProvider via the `providerCapabilities` message. */
export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return isReadingToolName(tool);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

const stepWaits = new WeakMap<Character, number>();

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
): Character {
  const col = seat ? seat.seatCol : 1;
  const row = seat ? seat.seatRow : 1;
  const center = tileCenter(col, row);
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };
}

/** Coordinated dancing starts only once the character has arrived on its Studio spot (never in place on the way). */
export function isDancingNow(ch: Character): boolean {
  const s = ch.smDanceSpot;
  return ch.smPose === 'dance' && ch.state !== CharacterState.WALK && !!s && ch.tileCol === s.col && ch.tileRow === s.row;
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  ch.frameTimer += dt;

  // Success Manager poses override the FSM: stand up, face the room, stay put (the renderer adds the
  // jump + raised hands). A walk in progress finishes first so nobody freezes mid-tile.
  if (isDragged(ch.id)) { // picked up by the owner: the canvas / drop handler places them, the FSM waits
    ch.state = CharacterState.IDLE;
    ch.path = [];
    ch.moveProgress = 0;
    ch.frame = 0;
    return;
  }
  if (isVoiceActive() && ch.id >= 0) {
    // The owner is talking: everyone (even mid-walk) stops, stands and faces the camera (renderer adds the tremble).
    if (ch.state === CharacterState.WALK) {
      ch.x = ch.tileCol * TILE_SIZE + TILE_SIZE / 2;
      ch.y = ch.tileRow * TILE_SIZE + TILE_SIZE / 2;
      ch.moveProgress = 0;
    }
    ch.state = CharacterState.IDLE;
    ch.dir = Direction.DOWN;
    ch.frame = 0;
    ch.path = [];
    return;
  }
  if (ch.smPose && ch.state !== CharacterState.WALK) {
    // Needing help: go back to your own desk first, so the user finds you in your department.
    // Dancing: walk to your spot on the Studio floor first.
    const goal = ch.smPose === 'help' && ch.seatId ? seats.get(ch.seatId) : ch.smPose === 'dance' && ch.smDanceSpot ? { seatCol: ch.smDanceSpot.col, seatRow: ch.smDanceSpot.row } : undefined;
    {
      const seat = goal;
      if (seat && (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow)) {
        const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles);
        if (path.length > 0) {
          ch.path = path;
          ch.moveProgress = 0;
          ch.state = CharacterState.WALK;
          ch.frame = 0;
          ch.frameTimer = 0;
          return;
        }
      }
    }
    ch.state = CharacterState.IDLE;
    ch.dir = Direction.DOWN;
    ch.frame = 0;
    ch.path = [];
    return;
  }

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 2;
      }
      // If no longer active, stand up and start wandering (after seatTimer expires)
      if (!ch.isActive) {
        // Only working agents use a computer: stand up at once.
        ch.seatTimer = 0;
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        ch.wanderCount = 0;
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
      }
      break;
    }

    case CharacterState.IDLE: {
      // No idle animation — static pose
      ch.frame = 0;
      if (ch.seatTimer < 0) ch.seatTimer = 0; // clear turn-end sentinel
      // If became active, pathfind to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId);
        if (seat) {
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            seat.seatCol,
            seat.seatRow,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
          } else {
            // Already at seat or no path — sit down
            ch.state = CharacterState.TYPE;
            ch.dir = seat.facingDir;
            ch.frame = 0;
            ch.frameTimer = 0;
          }
        }
        break;
      }
      // Success Manager: idle people go sit in the lounge and stay there instead of wandering.
      if (ch.smRestSeat) {
        const rest = seats.get(ch.smRestSeat);
        if (rest) {
          if (ch.tileCol === rest.seatCol && ch.tileRow === rest.seatRow) {
            ch.smResting = true;
            ch.dir = rest.facingDir;
            break;
          }
          ch.smResting = false;
          const path = findPath(ch.tileCol, ch.tileRow, rest.seatCol, rest.seatRow, tileMap, blockedTiles);
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
            break;
          }
        }
      }
      ch.smResting = false;
      // Working people without a desk stay put instead of wandering the corridors.
      if (ch.isActive && !ch.seatId) break;
      // Countdown wander timer
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        // Check if we've wandered enough — return to seat for a rest
        if (ch.isActive && ch.wanderCount >= ch.wanderLimit && ch.seatId) {
          const seat = seats.get(ch.seatId);
          if (seat) {
            const path = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
            );
            if (path.length > 0) {
              ch.path = path;
              ch.moveProgress = 0;
              ch.state = CharacterState.WALK;
              ch.frame = 0;
              ch.frameTimer = 0;
              break;
            }
          }
        }
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
            ch.wanderCount++;
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
      }
      break;
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 4;
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow);
        ch.x = center.x;
        ch.y = center.y;

        if (ch.isActive) {
          if (!ch.seatId) {
            // No desk: never work in the hallway, just stop (the rest-seat logic takes over).
            ch.state = CharacterState.IDLE;
          } else {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
            } else {
              ch.state = CharacterState.IDLE;
            }
          }
        } else {
          // Idle agents never sit at a computer; they just stop here.
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        }
        ch.frame = 0;
        ch.frameTimer = 0;
        break;
      }

      // Move toward next tile in path
      const nextTile = ch.path[0];
      if (ch.moveProgress === 0 && blockedTiles.has(`${nextTile.col},${nextTile.row}`)) {
        // Someone is standing there: wait a moment, then give up and pick a new route.
        const waited = (stepWaits.get(ch) ?? 0) + dt;
        if (waited > 1.5) { stepWaits.delete(ch); ch.path = []; ch.state = CharacterState.IDLE; ch.wanderTimer = 0.3; }
        else stepWaits.set(ch, waited);
        ch.frame = 0;
        break;
      }
      stepWaits.delete(ch);
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row);

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow);
      const toCenter = tileCenter(nextTile.col, nextTile.row);
      const t = Math.min(ch.moveProgress, 1);
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col;
        ch.tileRow = nextTile.row;
        ch.x = toCenter.x;
        ch.y = toCenter.y;
        ch.path.shift();
        ch.moveProgress = 0;
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        const seat = seats.get(ch.seatId);
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1];
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
            );
            if (newPath.length > 0) {
              ch.path = newPath;
              ch.moveProgress = 0;
            }
          }
        }
      }
      break;
    }
  }
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  if (isDancingNow(ch)) {
    // On the beat: hands up, step left, hands up, step right.
    const beat = Math.floor((performance.now() / 1000) * (SM_DANCE_BPM / 60) + ch.id) % 4;
    if (beat === 1) return sprites.walk[Direction.LEFT][0];
    if (beat === 3) return sprites.walk[Direction.RIGHT][2];
    return getHandsUpSprite(sprites.walk[Direction.DOWN][beat === 0 ? 1 : 0]);
  }
  if (ch.smPose && ch.smPose !== 'dance' && ch.state !== CharacterState.WALK) return getHandsUpSprite(sprites.walk[Direction.DOWN][1]);
  switch (ch.state) {
    case CharacterState.TYPE:
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2];
      }
      return sprites.typing[ch.dir][ch.frame % 2];
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4];
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1];
    default:
      return sprites.walk[ch.dir][1];
  }
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
