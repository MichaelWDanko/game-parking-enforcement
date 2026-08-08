export type WorldPoint = Readonly<{
  x: number;
  z: number;
}>;

export type CollisionAxis = "x" | "z";

type ColliderIdentity = Readonly<{
  id: string;
  group?: string;
}>;

export type CircleCollider = ColliderIdentity &
  Readonly<{
    shape: "circle";
    x: number;
    z: number;
    radius: number;
  }>;

export type BoxCollider = ColliderIdentity &
  Readonly<{
    shape: "box";
    x: number;
    z: number;
    halfWidth: number;
    halfDepth: number;
  }>;

export type WorldCollider = CircleCollider | BoxCollider;

export type CollisionBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type ChunkCollisionData = Readonly<{
  id: string;
  buildings: readonly Readonly<{
    side: -1 | 1;
    z: number;
    width: number;
    depth: number;
  }>[];
  trees: readonly Readonly<{
    side: -1 | 1;
    z: number;
  }>[];
  lamps: readonly Readonly<{
    side: -1 | 1;
    z: number;
  }>[];
}>;

export type ParkingMeterPlacement = Readonly<{
  axis: CollisionAxis;
  side: number;
  along: number;
}>;

export const OFFICER_COLLISION_RADIUS = 0.56;

export const WORLD_COLLISION_PROFILE = Object.freeze({
  meterRadius: 0.28,
  treeRadius: 0.58,
  lampRadius: 0.18,
  fountainRadius: 3.5,
  chunkBuildingX: 17,
  chunkTreeX: 10.4,
  chunkLampX: 11.25,
  meterStreetOffset: 7.4,
  meterAlongOffset: 2.3,
  parkedCarHalfWidth: 1.2,
  parkedCarHalfLength: 2.14,
});

function isFiniteNumber(value: number) {
  return Number.isFinite(value);
}

function validateCollider(collider: WorldCollider) {
  if (!collider.id) throw new Error("World colliders require a stable id");
  if (!isFiniteNumber(collider.x) || !isFiniteNumber(collider.z)) {
    throw new Error(`Collider ${collider.id} has an invalid position`);
  }
  if (collider.shape === "circle") {
    if (!isFiniteNumber(collider.radius) || collider.radius < 0) {
      throw new Error(`Collider ${collider.id} has an invalid radius`);
    }
    return;
  }
  if (
    !isFiniteNumber(collider.halfWidth) ||
    !isFiniteNumber(collider.halfDepth) ||
    collider.halfWidth < 0 ||
    collider.halfDepth < 0
  ) {
    throw new Error(`Collider ${collider.id} has invalid box dimensions`);
  }
}

export function colliderBounds(collider: WorldCollider): CollisionBounds {
  if (collider.shape === "circle") {
    return {
      minX: collider.x - collider.radius,
      maxX: collider.x + collider.radius,
      minZ: collider.z - collider.radius,
      maxZ: collider.z + collider.radius,
    };
  }
  return {
    minX: collider.x - collider.halfWidth,
    maxX: collider.x + collider.halfWidth,
    minZ: collider.z - collider.halfDepth,
    maxZ: collider.z + collider.halfDepth,
  };
}

export function circleIntersectsCollider(
  x: number,
  z: number,
  radius: number,
  collider: WorldCollider,
) {
  if (collider.shape === "circle") {
    const combinedRadius = radius + collider.radius;
    const dx = x - collider.x;
    const dz = z - collider.z;
    return dx * dx + dz * dz <= combinedRadius * combinedRadius;
  }

  const nearestX = Math.max(
    collider.x - collider.halfWidth,
    Math.min(x, collider.x + collider.halfWidth),
  );
  const nearestZ = Math.max(
    collider.z - collider.halfDepth,
    Math.min(z, collider.z + collider.halfDepth),
  );
  const dx = x - nearestX;
  const dz = z - nearestZ;
  return dx * dx + dz * dz <= radius * radius;
}

export function circleFitsWalkableArea(
  x: number,
  z: number,
  radius: number,
  isWalkable: (sampleX: number, sampleZ: number) => boolean,
  sampleCount = 16,
) {
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(z) ||
    !isFiniteNumber(radius) ||
    radius < 0 ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 4
  ) return false;
  if (!isWalkable(x, z)) return false;
  for (let index = 0; index < sampleCount; index++) {
    const angle = (index / sampleCount) * Math.PI * 2;
    if (!isWalkable(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius)) {
      return false;
    }
  }
  return true;
}

type GridCell = Readonly<{ x: number; z: number }>;

/**
 * A small spatial grid for solid world props. Static scenery is indexed once,
 * while the few moving or parked cars can be supplied per query.
 */
export class WorldCollisionIndex {
  readonly cellSize: number;

  private readonly colliders = new Map<string, WorldCollider>();
  private readonly cells = new Map<number, Map<number, Set<string>>>();
  private readonly memberships = new Map<string, GridCell[]>();

  constructor(cellSize = 8) {
    if (!isFiniteNumber(cellSize) || cellSize <= 0) {
      throw new Error("Collision grid cell size must be greater than zero");
    }
    this.cellSize = cellSize;
  }

  get size() {
    return this.colliders.size;
  }

  add(collider: WorldCollider) {
    validateCollider(collider);
    this.remove(collider.id);
    this.colliders.set(collider.id, collider);

    const memberships = this.cellsForBounds(colliderBounds(collider));
    this.memberships.set(collider.id, memberships);
    for (const cell of memberships) {
      let row = this.cells.get(cell.x);
      if (!row) {
        row = new Map();
        this.cells.set(cell.x, row);
      }
      let ids = row.get(cell.z);
      if (!ids) {
        ids = new Set();
        row.set(cell.z, ids);
      }
      ids.add(collider.id);
    }
    return this;
  }

  addMany(colliders: Iterable<WorldCollider>) {
    for (const collider of colliders) this.add(collider);
    return this;
  }

  remove(id: string) {
    const memberships = this.memberships.get(id);
    if (!memberships) return false;

    for (const cell of memberships) {
      const row = this.cells.get(cell.x);
      const ids = row?.get(cell.z);
      ids?.delete(id);
      if (ids?.size === 0) row?.delete(cell.z);
      if (row?.size === 0) this.cells.delete(cell.x);
    }
    this.memberships.delete(id);
    return this.colliders.delete(id);
  }

  removeGroup(group: string) {
    const ids: string[] = [];
    for (const collider of this.colliders.values()) {
      if (collider.group === group) ids.push(collider.id);
    }
    ids.forEach((id) => this.remove(id));
    return ids.length;
  }

  clear() {
    this.colliders.clear();
    this.cells.clear();
    this.memberships.clear();
  }

  intersections(
    x: number,
    z: number,
    radius = OFFICER_COLLISION_RADIUS,
    dynamicColliders: readonly WorldCollider[] = [],
  ) {
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(z) ||
      !isFiniteNumber(radius) ||
      radius < 0
    ) return [];
    const candidateBounds = {
      minX: x - radius,
      maxX: x + radius,
      minZ: z - radius,
      maxZ: z + radius,
    };
    const candidateIds = new Set<string>();
    for (const cell of this.cellsForBounds(candidateBounds)) {
      const ids = this.cells.get(cell.x)?.get(cell.z);
      ids?.forEach((id) => candidateIds.add(id));
    }

    const intersections: WorldCollider[] = [];
    for (const id of candidateIds) {
      const collider = this.colliders.get(id);
      if (collider && circleIntersectsCollider(x, z, radius, collider)) {
        intersections.push(collider);
      }
    }
    for (const collider of dynamicColliders) {
      if (circleIntersectsCollider(x, z, radius, collider)) {
        intersections.push(collider);
      }
    }
    return intersections;
  }

  blocksCircle(
    x: number,
    z: number,
    radius = OFFICER_COLLISION_RADIUS,
    dynamicColliders: readonly WorldCollider[] = [],
  ) {
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(z) ||
      !isFiniteNumber(radius) ||
      radius < 0
    ) return false;
    const candidateBounds = {
      minX: x - radius,
      maxX: x + radius,
      minZ: z - radius,
      maxZ: z + radius,
    };
    const checkedIds = new Set<string>();
    for (const cell of this.cellsForBounds(candidateBounds)) {
      const ids = this.cells.get(cell.x)?.get(cell.z);
      if (!ids) continue;
      for (const id of ids) {
        if (checkedIds.has(id)) continue;
        checkedIds.add(id);
        const collider = this.colliders.get(id);
        if (collider && circleIntersectsCollider(x, z, radius, collider)) return true;
      }
    }
    return dynamicColliders.some((collider) =>
      circleIntersectsCollider(x, z, radius, collider),
    );
  }

  private cellsForBounds(bounds: CollisionBounds) {
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellZ = Math.floor(bounds.minZ / this.cellSize);
    const maxCellZ = Math.floor(bounds.maxZ / this.cellSize);
    const cells: GridCell[] = [];
    for (let x = minCellX; x <= maxCellX; x++) {
      for (let z = minCellZ; z <= maxCellZ; z++) cells.push({ x, z });
    }
    return cells;
  }
}

export function createBuildingCollider(
  id: string,
  x: number,
  z: number,
  width: number,
  depth: number,
  group?: string,
): BoxCollider {
  return {
    id,
    group,
    shape: "box",
    x,
    z,
    halfWidth: width / 2,
    halfDepth: depth / 2,
  };
}

export function createParkingMeterCollider(
  id: string,
  placement: ParkingMeterPlacement,
  group = "parking-meters",
): CircleCollider {
  const { axis, side, along } = placement;
  return {
    id,
    group,
    shape: "circle",
    x:
      axis === "z"
        ? side * WORLD_COLLISION_PROFILE.meterStreetOffset
        : along + WORLD_COLLISION_PROFILE.meterAlongOffset,
    z:
      axis === "x"
        ? side * WORLD_COLLISION_PROFILE.meterStreetOffset
        : along + WORLD_COLLISION_PROFILE.meterAlongOffset,
    radius: WORLD_COLLISION_PROFILE.meterRadius,
  };
}

export function createFountainCollider(
  id: string,
  x: number,
  z: number,
  radius = WORLD_COLLISION_PROFILE.fountainRadius,
  group = "fixed-scenery",
): CircleCollider {
  return { id, group, shape: "circle", x, z, radius };
}

export function isCrossStreetScenery(z: number) {
  return Math.abs(z) <= 11 || Math.abs(z - 32) <= 10;
}

/** Creates colliders at the same coordinates used by createCityChunk. */
export function createChunkSceneryColliders(
  data: ChunkCollisionData,
  excludeAtZ: (z: number) => boolean = isCrossStreetScenery,
) {
  const group = `chunk:${data.id}`;
  const colliders: WorldCollider[] = [];

  data.buildings.forEach((building, index) => {
    if (excludeAtZ(building.z)) return;
    colliders.push(
      createBuildingCollider(
        `${group}:building:${index}`,
        building.side * WORLD_COLLISION_PROFILE.chunkBuildingX,
        building.z,
        building.width,
        building.depth,
        group,
      ),
    );
  });
  data.trees.forEach((tree, index) => {
    if (excludeAtZ(tree.z)) return;
    colliders.push({
      id: `${group}:tree:${index}`,
      group,
      shape: "circle",
      x: tree.side * WORLD_COLLISION_PROFILE.chunkTreeX,
      z: tree.z,
      radius: WORLD_COLLISION_PROFILE.treeRadius,
    });
  });
  data.lamps.forEach((lamp, index) => {
    if (excludeAtZ(lamp.z)) return;
    colliders.push({
      id: `${group}:lamp:${index}`,
      group,
      shape: "circle",
      x: lamp.side * WORLD_COLLISION_PROFILE.chunkLampX,
      z: lamp.z,
      radius: WORLD_COLLISION_PROFILE.lampRadius,
    });
  });

  return colliders;
}

export function createVehicleCollider(
  id: string,
  axis: CollisionAxis,
  x: number,
  z: number,
  scale = 1,
  group = "vehicles",
): BoxCollider {
  const halfWidth = WORLD_COLLISION_PROFILE.parkedCarHalfWidth * scale;
  const halfLength = WORLD_COLLISION_PROFILE.parkedCarHalfLength * scale;
  return {
    id,
    group,
    shape: "box",
    x,
    z,
    halfWidth: axis === "x" ? halfLength : halfWidth,
    halfDepth: axis === "z" ? halfLength : halfWidth,
  };
}
