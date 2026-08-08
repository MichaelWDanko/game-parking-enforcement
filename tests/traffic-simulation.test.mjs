import assert from "node:assert/strict";
import test from "node:test";
import {
  nearestTrafficGap,
  parkingRoutePosition,
  parkingTravelDirection,
  TRAFFIC_BRAKE_DISTANCE,
  TRAFFIC_LOOP_MAX,
  TRAFFIC_LOOP_MIN,
  trafficVehiclesOverlap,
} from "../app/traffic-collision.ts";

const STEP_SECONDS = 1 / 60;
const SHIFT_SECONDS = 90;
const RUSH_HOUR_START = 30;
const RUSH_HOUR_END = 50;

function damp(current, target, smoothing) {
  return current + (target - current) * (1 - Math.exp(-smoothing * STEP_SECONDS));
}

function createLoopCars() {
  const cars = [];

  for (let index = 0; index < 6; index++) {
    const lane = index % 2 === 0 ? -1.9 : 1.9;
    const cruiseSpeed = lane < 0 ? 5.2 + index * 0.45 : -(5.2 + index * 0.45);
    cars.push({
      id: `loop-z-${index}`,
      kind: "loop",
      axis: "z",
      direction: Math.sign(cruiseSpeed),
      position: { axis: "z", x: lane, z: -50 + index * 20, scale: 0.82 },
      speed: cruiseSpeed,
      cruiseSpeed,
      distance: 0,
      wraps: 0,
    });
  }

  for (let index = 0; index < 4; index++) {
    const lane = index % 2 === 0 ? -1.9 : 1.9;
    const cruiseSpeed = lane < 0 ? 5.6 + index * 0.4 : -(5.6 + index * 0.4);
    cars.push({
      id: `loop-x-${index}`,
      kind: "loop",
      axis: "x",
      direction: Math.sign(cruiseSpeed),
      position: { axis: "x", x: -48 + index * 30, z: lane, scale: 0.82 },
      speed: cruiseSpeed,
      cruiseSpeed,
      distance: 0,
      wraps: 0,
    });
  }

  return cars;
}

function createParkingCars() {
  const cars = [];
  for (const axis of ["z", "x"]) {
    for (const side of [-1, 1]) {
      const nearAlong = side < 0 ? -30 : 30;
      const farAlong = -nearAlong;
      for (const [queueIndex, along] of [nearAlong, farAlong].entries()) {
        cars.push({
          id: `parking-${axis}-${side}-${queueIndex}`,
          kind: "parking",
          axis,
          direction: parkingTravelDirection(side),
          spot: {
            axis,
            side,
            x: axis === "z" ? side * 5.35 : along,
            z: axis === "x" ? side * 5.35 : along,
          },
          spawnAt: axis === "z" ? 2 : 6,
          phase: "pending",
          phaseTime: 0,
          driveRate: 1,
          position: null,
          parkedAt: null,
          distance: 0,
          spawnDeferrals: 0,
          intersectionCrossings: 0,
        });
      }
    }
  }
  return cars;
}

function routeDuration(car, phase) {
  const start = parkingRoutePosition(car.spot, phase, 0);
  const end = parkingRoutePosition(car.spot, phase, 1);
  const startAlong = car.axis === "z" ? start.z : start.x;
  const endAlong = car.axis === "z" ? end.z : end.x;
  return Math.max(phase === "arriving" ? 2.2 : 2.4, Math.abs(endAlong - startAlong) / 7);
}

function assertNoOverlaps(vehicles, tick) {
  for (let first = 0; first < vehicles.length; first++) {
    for (let second = first + 1; second < vehicles.length; second++) {
      assert.equal(
        trafficVehiclesOverlap(vehicles[first].position, vehicles[second].position),
        false,
        `${vehicles[first].id} overlaps ${vehicles[second].id} at tick ${tick}`,
      );
    }
  }
}

test("keeps a complete 90-second traffic shift collision-free", () => {
  const loopCars = createLoopCars();
  const parkingCars = createParkingCars();
  const wrapDirections = new Set();
  const intersectionAxes = new Set();
  const deferredSpawns = new Set();
  let crossAxisBlocks = 0;
  let rushHourAccelerations = 0;

  const activeVehicles = () => [
    ...loopCars,
    ...parkingCars.filter(
      (car) => car.phase !== "pending" && car.phase !== "finished",
    ),
  ];
  const otherPositions = (excluded) =>
    activeVehicles()
      .filter((vehicle) => vehicle !== excluded)
      .map((vehicle) => vehicle.position);
  const blockingVehicles = (candidate, excluded) =>
    activeVehicles().filter(
      (vehicle) =>
        vehicle !== excluded && trafficVehiclesOverlap(candidate, vehicle.position),
    );

  assert.equal(loopCars.length, 10);
  assert.deepEqual(
    new Set(parkingCars.map((car) => `${car.axis}:${car.direction}`)),
    new Set(["x:-1", "x:1", "z:-1", "z:1"]),
  );
  assertNoOverlaps(activeVehicles(), 0);

  for (let tick = 1; tick <= SHIFT_SECONDS / STEP_SECONDS; tick++) {
    const now = tick * STEP_SECONDS;
    const rushHour = now >= RUSH_HOUR_START && now < RUSH_HOUR_END;
    const speedMultiplier = rushHour ? 1.3 : 1;

    for (const car of loopCars) {
      const coordinate = car.axis;
      const currentCoordinate = car.position[coordinate];
      const gap = nearestTrafficGap(
        car.position,
        car.direction,
        otherPositions(car),
      );
      const braking = gap < TRAFFIC_BRAKE_DISTANCE;
      car.speed = damp(
        car.speed,
        braking ? 0 : car.cruiseSpeed * speedMultiplier,
        braking ? 7.5 : 2.4,
      );
      if (rushHour && Math.abs(car.speed) > Math.abs(car.cruiseSpeed) * 1.05) {
        rushHourAccelerations++;
      }

      let nextCoordinate = currentCoordinate + car.speed * STEP_SECONDS;
      let wrapping = false;
      if (nextCoordinate > TRAFFIC_LOOP_MAX) {
        nextCoordinate = TRAFFIC_LOOP_MIN;
        wrapping = true;
      } else if (nextCoordinate < TRAFFIC_LOOP_MIN) {
        nextCoordinate = TRAFFIC_LOOP_MAX;
        wrapping = true;
      }
      const candidate = { ...car.position, [coordinate]: nextCoordinate };
      const blockers = blockingVehicles(candidate, car);
      if (blockers.length > 0) {
        car.speed = 0;
        crossAxisBlocks += blockers.filter((other) => other.axis !== car.axis).length;
        continue;
      }

      if (currentCoordinate * nextCoordinate <= 0) intersectionAxes.add(car.axis);
      car.distance += wrapping
        ? Math.abs(
            car.direction > 0
              ? TRAFFIC_LOOP_MAX - currentCoordinate + nextCoordinate - TRAFFIC_LOOP_MIN
              : currentCoordinate - TRAFFIC_LOOP_MIN + TRAFFIC_LOOP_MAX - nextCoordinate,
          )
        : Math.abs(nextCoordinate - currentCoordinate);
      car.position = candidate;
      if (wrapping) {
        car.wraps++;
        wrapDirections.add(`${car.axis}:${car.direction}`);
      }
    }

    for (const car of parkingCars) {
      if (car.phase === "pending") {
        if (now < car.spawnAt) continue;
        const candidate = {
          ...parkingRoutePosition(car.spot, "arriving", 0),
          scale: 1,
        };
        if (blockingVehicles(candidate, car).length > 0) {
          car.spawnDeferrals++;
          deferredSpawns.add(car.id);
          continue;
        }
        car.position = candidate;
        car.phase = "arriving";
        continue;
      }

      if (car.phase === "parked") {
        if (now - car.parkedAt >= 3) {
          car.phase = "leaving";
          car.phaseTime = 0;
          car.driveRate = 0;
        }
        continue;
      }
      if (car.phase === "finished") continue;

      const phase = car.phase;
      const gap = nearestTrafficGap(
        car.position,
        car.direction,
        otherPositions(car),
      );
      const braking = gap < TRAFFIC_BRAKE_DISTANCE;
      car.driveRate = damp(
        car.driveRate,
        braking ? 0 : 1,
        braking ? 8 : 2.5,
      );
      const nextPhaseTime = car.phaseTime + STEP_SECONDS * car.driveRate;
      const progress = Math.min(1, nextPhaseTime / routeDuration(car, phase));
      const candidate = {
        ...parkingRoutePosition(car.spot, phase, progress),
        scale: 1,
      };
      const blockers = blockingVehicles(candidate, car);
      if (blockers.length > 0) {
        car.driveRate = 0;
        crossAxisBlocks += blockers.filter((other) => other.axis !== car.axis).length;
        continue;
      }

      const previousAlong = car.position[car.axis];
      const nextAlong = candidate[car.axis];
      if (previousAlong * nextAlong <= 0 && previousAlong !== nextAlong) {
        car.intersectionCrossings++;
        intersectionAxes.add(car.axis);
      }
      car.distance += Math.hypot(
        candidate.x - car.position.x,
        candidate.z - car.position.z,
      );
      car.position = candidate;
      car.phaseTime = nextPhaseTime;

      if (progress >= 1) {
        if (phase === "arriving") {
          car.phase = "parked";
          car.phaseTime = 0;
          car.driveRate = 0;
          car.parkedAt = now;
        } else {
          car.phase = "finished";
        }
      }
    }

    assertNoOverlaps(activeVehicles(), tick);
  }

  assert.deepEqual(
    wrapDirections,
    new Set(["x:-1", "x:1", "z:-1", "z:1"]),
    "loop traffic must re-enter from both ends of both road axes",
  );
  assert.deepEqual(intersectionAxes, new Set(["x", "z"]));
  assert.ok(crossAxisBlocks > 0, "perpendicular traffic must exercise intersection blocking");
  assert.ok(rushHourAccelerations > 0, "rush hour must accelerate traffic above cruise speed");
  assert.ok(deferredSpawns.size >= 4, "each shared curb entry must defer at least one car");
  assert.equal(
    parkingCars.every((car) => car.phase === "finished"),
    true,
    `unfinished parking cars: ${parkingCars
      .filter((car) => car.phase !== "finished")
      .map((car) => `${car.id}:${car.phase}`)
      .join(", ")}`,
  );
  assert.equal(parkingCars.every((car) => car.intersectionCrossings > 0), true);
  assert.equal(parkingCars.every((car) => car.distance > 40), true);
  assert.equal(loopCars.every((car) => car.distance > 120 && car.wraps > 0), true);
});
