import assert from "node:assert/strict";
import test from "node:test";
import {
  parkingRoutePosition,
  parkingTravelDirection,
  trafficVehiclesOverlap,
} from "../app/traffic-collision.ts";

const STEP_SECONDS = 1 / 60;

test("routes each curb side with the matching direction of traffic", () => {
  const northbound = { axis: "z", side: -1, x: -5.35, z: 12 };
  const southbound = { axis: "z", side: 1, x: 5.35, z: 12 };

  assert.equal(parkingTravelDirection(northbound.side), 1);
  assert.equal(parkingTravelDirection(southbound.side), -1);
  assert.deepEqual(parkingRoutePosition(northbound, "arriving", 0), {
    axis: "z",
    x: -1.9,
    z: -52,
  });
  assert.deepEqual(parkingRoutePosition(southbound, "arriving", 0), {
    axis: "z",
    x: 1.9,
    z: 52,
  });
  assert.deepEqual(parkingRoutePosition(northbound, "arriving", 1), {
    axis: "z",
    x: -5.35,
    z: 12,
  });
  assert.deepEqual(parkingRoutePosition(southbound, "leaving", 1), {
    axis: "z",
    x: 1.9,
    z: -52,
  });
});

test("queues parking traffic without crossing cars already at the curb", () => {
  const spots = [-36, -12, 12, 36].map((z, index) => ({
    axis: "z",
    side: -1,
    x: -5.35,
    z,
    spawnAt: 2 + index * 2,
  }));
  const cars = [];

  for (let tick = 0; tick < 60 * 75; tick++) {
    const now = tick * STEP_SECONDS;
    for (const spot of spots) {
      if (cars.some((car) => car.spot === spot) || now < spot.spawnAt) continue;
      const position = parkingRoutePosition(spot, "arriving", 0);
      if (cars.every((car) => !trafficVehiclesOverlap(position, car.position))) {
        cars.push({ spot, phaseTime: 0, parked: false, position });
      }
    }

    for (const car of cars) {
      if (car.parked) continue;
      const start = parkingRoutePosition(car.spot, "arriving", 0);
      const end = parkingRoutePosition(car.spot, "arriving", 1);
      const duration = Math.max(2.2, Math.abs(end.z - start.z) / 7);
      const nextPhaseTime = car.phaseTime + STEP_SECONDS;
      const progress = Math.min(1, nextPhaseTime / duration);
      const candidate = parkingRoutePosition(car.spot, "arriving", progress);
      const blocked = cars.some(
        (other) => other !== car && trafficVehiclesOverlap(candidate, other.position),
      );
      if (!blocked) {
        car.phaseTime = nextPhaseTime;
        car.position = candidate;
        car.parked = progress >= 1;
      }
    }

    for (let first = 0; first < cars.length; first++) {
      for (let second = first + 1; second < cars.length; second++) {
        assert.equal(
          trafficVehiclesOverlap(cars[first].position, cars[second].position),
          false,
          `cars ${first} and ${second} overlap at ${now.toFixed(3)}s`,
        );
      }
    }
  }

  assert.equal(cars.length, spots.length);
  assert.equal(cars.every((car) => car.parked), true);
});

test("uses rendered vehicle scale when comparing clearances", () => {
  const fullSize = { axis: "z", x: 0, z: 0, scale: 1 };
  const otherFullSize = { axis: "z", x: 0, z: 4.5, scale: 1 };
  const compactTraffic = { axis: "z", x: 0, z: 4.5, scale: 0.82 };

  assert.equal(trafficVehiclesOverlap(fullSize, otherFullSize), true);
  assert.equal(trafficVehiclesOverlap(fullSize, compactTraffic), false);
});
