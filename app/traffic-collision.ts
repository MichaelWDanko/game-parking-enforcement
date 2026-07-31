export type TrafficAxis = "x" | "z";

export type TrafficVehiclePosition = {
  axis: TrafficAxis;
  x: number;
  z: number;
};

export const TRAFFIC_LOOP_MIN = -58;
export const TRAFFIC_LOOP_MAX = 58;
export const TRAFFIC_BRAKE_DISTANCE = 8;

const TRAFFIC_HALF_LENGTH = 1.75;
const TRAFFIC_HALF_WIDTH = 0.95;
const TRAFFIC_CLEARANCE = 0.45;
const SAME_LANE_DISTANCE = TRAFFIC_HALF_WIDTH * 2 + TRAFFIC_CLEARANCE;

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
    if (Math.abs(otherAcross - across) >= SAME_LANE_DISTANCE) continue;

    const gap = forwardLoopDistance(along, otherAlong, direction);
    if (gap > 0.001) nearestGap = Math.min(nearestGap, gap);
  }

  return nearestGap;
}

export function trafficVehiclesOverlap(
  first: TrafficVehiclePosition,
  second: TrafficVehiclePosition,
) {
  const firstHalfX = first.axis === "x" ? TRAFFIC_HALF_LENGTH : TRAFFIC_HALF_WIDTH;
  const firstHalfZ = first.axis === "z" ? TRAFFIC_HALF_LENGTH : TRAFFIC_HALF_WIDTH;
  const secondHalfX = second.axis === "x" ? TRAFFIC_HALF_LENGTH : TRAFFIC_HALF_WIDTH;
  const secondHalfZ = second.axis === "z" ? TRAFFIC_HALF_LENGTH : TRAFFIC_HALF_WIDTH;

  return (
    Math.abs(first.x - second.x) < firstHalfX + secondHalfX + TRAFFIC_CLEARANCE &&
    Math.abs(first.z - second.z) < firstHalfZ + secondHalfZ + TRAFFIC_CLEARANCE
  );
}
