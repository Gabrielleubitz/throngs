import type { SpriteData } from '../types.js';
import { ZOO_PET_NAMES, zooPetTemplates } from './zooAnimals.js';

/**
 * Resolved per-pet sprite frames. Each entry is a 3-frame animation array.
 * `walkLeft` / `idleRight` / `idleLeft` are derived in setPetTemplates from
 * the broadcast fields.
 */
export interface PetSpriteFrames {
  walkDown: [SpriteData, SpriteData, SpriteData];
  idleDown: [SpriteData, SpriteData, SpriteData];
  walkUp: [SpriteData, SpriteData, SpriteData];
  idleUp: [SpriteData, SpriteData, SpriteData];
  walkRight: [SpriteData, SpriteData, SpriteData];
  walkLeft: [SpriteData, SpriteData, SpriteData];
  idleRight: [SpriteData, SpriteData, SpriteData];
  idleLeft: [SpriteData, SpriteData, SpriteData];
}

/** Flip a sprite horizontally (used for walkRight → walkLeft). */
function flipHorizontal(s: SpriteData): SpriteData {
  return s.map((row) => [...row].reverse());
}

/** Coerce a 3-frame raw array to a fixed-length tuple. Caller must verify len ≥ 3 first. */
function toTriple(arr: string[][][]): [SpriteData, SpriteData, SpriteData] {
  return [arr[0], arr[1], arr[2]];
}

let loadedPets: PetSpriteFrames[] | null = null;
let loadedPetNames: string[] = [];

/**
 * Receive raw frame arrays + parallel display names from the server message.
 * Skips entries with fewer than 3 frames in any of the required directions.
 */
export function setPetTemplates(
  data: Array<{
    walkDown: string[][][];
    idleDown: string[][][];
    walkUp: string[][][];
    idleUp: string[][][];
    walkRight: string[][][];
  }>,
  petNames?: string[],
): void {
  const resolved: PetSpriteFrames[] = [];
  const resolvedNames: string[] = [];
  // Success Manager: the zoo animals follow the bundled pets, so their petType is stable (2+).
  const all = [...data, ...zooPetTemplates()];
  const allNames = [...(petNames ?? []), ...ZOO_PET_NAMES];
  for (let i = 0; i < all.length; i++) {
    const raw = all[i];
    if (
      !raw ||
      !raw.walkDown ||
      raw.walkDown.length < 3 ||
      !raw.idleDown ||
      raw.idleDown.length < 3 ||
      !raw.walkUp ||
      raw.walkUp.length < 3 ||
      !raw.idleUp ||
      raw.idleUp.length < 3 ||
      !raw.walkRight ||
      raw.walkRight.length < 3
    ) {
      continue;
    }
    const walkDown = toTriple(raw.walkDown);
    const idleDown = toTriple(raw.idleDown);
    const walkUp = toTriple(raw.walkUp);
    const idleUp = toTriple(raw.idleUp);
    const walkRight = toTriple(raw.walkRight);
    const walkLeft: [SpriteData, SpriteData, SpriteData] = [
      flipHorizontal(walkRight[0]),
      flipHorizontal(walkRight[1]),
      flipHorizontal(walkRight[2]),
    ];
    // The pet's front-facing idle stands in for "idle right"; the back-facing
    // idle stands in for "idle left". No flip — the side-on pose isn't authored.
    resolved.push({
      walkDown,
      idleDown,
      walkUp,
      idleUp,
      walkRight,
      walkLeft,
      idleRight: idleDown,
      idleLeft: idleUp,
    });
    resolvedNames.push(allNames[i] ?? `Pet ${i + 1}`);
  }
  loadedPets = resolved;
  loadedPetNames = resolvedNames;
}

/** Returns the resolved frames for a petType, or null if not loaded or out of range. */
export function getPetSprites(petIndex: number): PetSpriteFrames | null {
  if (!loadedPets) return null;
  if (petIndex < 0 || petIndex >= loadedPets.length) return null;
  return loadedPets[petIndex];
}

/** Number of pets currently loaded. */
export function getPetCount(): number {
  return loadedPets?.length ?? 0;
}

/** Display name for a petType. Falls back to "Pet N" when manifest missing. */
export function getPetName(petIndex: number): string {
  return loadedPetNames[petIndex] ?? `Pet ${petIndex + 1}`;
}

/** petType of zoo animal `k` (they are the last pets loaded), or -1 when not loaded. */
export function zooPetType(k: number): number {
  const base = (loadedPets?.length ?? 0) - ZOO_PET_NAMES.length;
  return base < 0 || k < 0 || k >= ZOO_PET_NAMES.length ? -1 : base + k;
}
