export type TrafficAxis = "x" | "z";

export type TrafficVehiclePosition = {
  axis: TrafficAxis;
  x: number;
  z: number;
  scale?: number;
};

export type ParkingRouteSpot = {
  axis: TrafficAxis;
  side: number;
  x: number;
  z: number;
};

export const TRAFFIC_LOOP_MIN = -58;
export const TRAFFIC_LOOP_MAX = 58;
export const TRAFFIC_BRAKE_DISTANCE = 8;
export const TRAFFIC_LANE_OFFSET = 1.9;
export const PARKING_ROUTE_BOUND = 52;
export const VEHICLE_HALF_LENGTH = 2.14;
export const VEHICLE_HALF_WIDTH = 1.2;

const TRAFFIC_CLEARANCE = 0.45;

function vehicleHalfLength(vehicle: TrafficVehiclePosition) {
  return VEHICLE_HALF_LENGTH * (vehicle.scale ?? 1);
}

function vehicleHalfWidth(vehicle: TrafficVehiclePosition) {
  return VEHICLE_HALF_WIDTH * (vehicle.scale ?? 1);
}

export function forwardLoopDistance(
  from: number,
  to: number,
  direction: number,
  loopMin = TRAFFIC_LOOP_MIN,
  loopMax = TRAFFIC_LOOP_MAX,
) {
  const loopLength = loopMax - loopMin;
  const directedDistance = (to - from) * direction;
  return ((directedDistance % loopLength) + loopLength) % loopLength;
}

export function nearestTrafficGap(
  vehicle: TrafficVehiclePosition,
  direction: number,
  otherVehicles: readonly TrafficVehiclePosition[],
) {
  const along = vehicle.axis === "z" ? vehicle.z : vehicle.x;
  const across = vehicle.axis === "z" ? vehicle.x : vehicle.z;
  let nearestGap = Number.POSITIVE_INFINITY;

  for (const other of otherVehicles) {
    if (other.axis !== vehicle.axis) continue;
    const otherAlong = vehicle.axis === "z" ? other.z : other.x;
    const otherAcross = vehicle.axis === "z" ? other.x : other.z;
    const sameLaneDistance =
      vehicleHalfWidth(vehicle) + vehicleHalfWidth(other) + TRAFFIC_CLEARANCE;
    if (Math.abs(otherAcross - across) >= sameLaneDistance) continue;

    const gap = forwardLoopDistance(along, otherAlong, direction);
    if (gap > 0.001) nearestGap = Math.min(nearestGap, gap);
  }

  return nearestGap;
}

export function trafficVehiclesOverlap(
  first: TrafficVehiclePosition,
  second: TrafficVehiclePosition,
) {
  const firstHalfX = first.axis === "x" ? vehicleHalfLength(first) : vehicleHalfWidth(first);
  const firstHalfZ = first.axis === "z" ? vehicleHalfLength(first) : vehicleHalfWidth(first);
  const secondHalfX = second.axis === "x" ? vehicleHalfLength(second) : vehicleHalfWidth(second);
  const secondHalfZ = second.axis === "z" ? vehicleHalfLength(second) : vehicleHalfWidth(second);

  return (
    Math.abs(first.x - second.x) < firstHalfX + secondHalfX + TRAFFIC_CLEARANCE &&
    Math.abs(first.z - second.z) < firstHalfZ + secondHalfZ + TRAFFIC_CLEARANCE
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number) {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

export function parkingTravelDirection(side: number) {
  return side < 0 ? 1 : -1;
}

/**
 * Keeps parking traffic in the adjacent travel lane until it reaches its spot.
 * This lets later cars pass parked vehicles without clipping through them.
 */
export function parkingRoutePosition(
  spot: ParkingRouteSpot,
  phase: "arriving" | "leaving",
  progress: number,
): TrafficVehiclePosition {
  const clampedProgress = clamp01(progress);
  const direction = parkingTravelDirection(spot.side);
  const entry = direction > 0 ? -PARKING_ROUTE_BOUND : PARKING_ROUTE_BOUND;
  const exit = -entry;
  const parkedAlong = spot.axis === "z" ? spot.z : spot.x;
  const parkedAcross = spot.axis === "z" ? spot.x : spot.z;
  const laneAcross = spot.side * TRAFFIC_LANE_OFFSET;

  let along: number;
  let across: number;
  if (phase === "arriving") {
    const easedAlong = 1 - Math.pow(1 - clampedProgress, 3);
    const merge = smoothStep((clampedProgress - 0.68) / 0.32);
    along = entry + (parkedAlong - entry) * easedAlong;
    across = laneAcross + (parkedAcross - laneAcross) * merge;
  } else {
    const easedAlong = clampedProgress * clampedProgress;
    const merge = smoothStep(clampedProgress / 0.32);
    along = parkedAlong + (exit - parkedAlong) * easedAlong;
    across = parkedAcross + (laneAcross - parkedAcross) * merge;
  }

  return spot.axis === "z"
    ? { axis: spot.axis, x: across, z: along }
    : { axis: spot.axis, x: along, z: across };
}
