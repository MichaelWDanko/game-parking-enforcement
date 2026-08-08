import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFICER_COLLISION_RADIUS,
  WorldCollisionIndex,
  circleFitsWalkableArea,
  circleIntersectsCollider,
  createBuildingCollider,
  createChunkSceneryColliders,
  createFountainCollider,
  createParkingMeterCollider,
  createVehicleCollider,
} from "../app/world-collision.ts";

test("detects circle contact with round and rectangular scenery", () => {
  const tree = { id: "tree", shape: "circle", x: 3, z: 2, radius: 0.5 };
  const building = createBuildingCollider("building", 10, 10, 8, 6);

  assert.equal(circleIntersectsCollider(2, 2, 0.5, tree), true);
  assert.equal(circleIntersectsCollider(1.99, 2, 0.5, tree), false);
  assert.equal(circleIntersectsCollider(5.5, 10, 0.5, building), true);
  assert.equal(circleIntersectsCollider(5.49, 10, 0.5, building), false);
  assert.equal(circleIntersectsCollider(5.6, 6.6, 0.5, building), false);
});

test("keeps the officer footprint inside the walkable boundary", () => {
  const isWalkable = (x, z) => Math.abs(x) <= 4 && Math.abs(z) <= 6;

  assert.equal(circleFitsWalkableArea(0, 0, 0.56, isWalkable), true);
  assert.equal(circleFitsWalkableArea(3.7, 0, 0.56, isWalkable), false);
  assert.equal(circleFitsWalkableArea(0, 5.7, 0.56, isWalkable), false);
  assert.equal(circleFitsWalkableArea(5, 0, 0.56, isWalkable), false);
});

test("indexes negative coordinates and updates colliders by stable id", () => {
  const index = new WorldCollisionIndex(4);
  index.add({ id: "lamp", shape: "circle", x: -8, z: -9, radius: 0.2 });

  assert.equal(index.blocksCircle(-8.6, -9, 0.4), true);
  assert.equal(index.blocksCircle(8, 9, 0.4), false);

  index.add({ id: "lamp", shape: "circle", x: 8, z: 9, radius: 0.2 });
  assert.equal(index.size, 1);
  assert.equal(index.blocksCircle(-8.6, -9, 0.4), false);
  assert.equal(index.blocksCircle(8.6, 9, 0.4), true);
  assert.equal(index.remove("lamp"), true);
  assert.equal(index.blocksCircle(8, 9, 0.4), false);
});

test("adds and removes streamed scenery as a chunk group", () => {
  const index = new WorldCollisionIndex();
  index.addMany([
    { id: "chunk:market:tree:0", group: "chunk:market", shape: "circle", x: -10, z: -40, radius: 0.5 },
    { id: "chunk:market:lamp:0", group: "chunk:market", shape: "circle", x: -11, z: -42, radius: 0.2 },
    createFountainCollider("fountain", 30, 47),
  ]);

  assert.equal(index.size, 3);
  assert.equal(index.removeGroup("chunk:market"), 2);
  assert.equal(index.size, 1);
  assert.equal(index.blocksCircle(30, 43.1, OFFICER_COLLISION_RADIUS), true);
});

test("checks dynamic vehicles without rebuilding the static grid", () => {
  const index = new WorldCollisionIndex();
  const parkedCar = createVehicleCollider("parked", "z", -5.35, -12);

  assert.equal(index.size, 0);
  assert.equal(index.blocksCircle(-5.35, -9.5, 0.4, [parkedCar]), true);
  assert.equal(index.blocksCircle(-3.85, -12, 0.4, [parkedCar]), true);
  assert.equal(index.blocksCircle(-3.8, -9.4, 0.4, [parkedCar]), false);

  const crossStreetCar = createVehicleCollider("cross-street", "x", 18, 5.35);
  assert.ok(crossStreetCar.halfWidth > crossStreetCar.halfDepth);
});

test("maps both parking-meter orientations to rendered coordinates", () => {
  assert.deepEqual(createParkingMeterCollider("main", {
    axis: "z",
    side: -1,
    along: -12,
  }), {
    id: "main",
    group: "parking-meters",
    shape: "circle",
    x: -7.4,
    z: -9.7,
    radius: 0.28,
  });
  assert.deepEqual(createParkingMeterCollider("cross", {
    axis: "x",
    side: 1,
    along: 18,
  }), {
    id: "cross",
    group: "parking-meters",
    shape: "circle",
    x: 20.3,
    z: 7.4,
    radius: 0.28,
  });
});

test("derives streamed building, tree, and lamp geometry from chunk data", () => {
  const colliders = createChunkSceneryColliders({
    id: "arts",
    buildings: [
      { side: -1, z: -30, width: 9, depth: 10 },
      { side: 1, z: 6, width: 8, depth: 10 },
    ],
    trees: [
      { side: 1, z: -23 },
      { side: -1, z: 1 },
    ],
    lamps: [
      { side: -1, z: -28 },
      { side: 1, z: 5 },
    ],
  });

  assert.deepEqual(colliders.map(({ id }) => id), [
    "chunk:arts:building:0",
    "chunk:arts:tree:0",
    "chunk:arts:lamp:0",
  ]);
  assert.deepEqual(colliders[0], {
    id: "chunk:arts:building:0",
    group: "chunk:arts",
    shape: "box",
    x: -17,
    z: -30,
    halfWidth: 4.5,
    halfDepth: 5,
  });
  assert.deepEqual(colliders[1], {
    id: "chunk:arts:tree:0",
    group: "chunk:arts",
    shape: "circle",
    x: 10.4,
    z: -23,
    radius: 0.58,
  });
});
