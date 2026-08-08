export const DAILY_RULESET_VERSION = 3;
export const SHIFT_DURATION_SECONDS = 90;
export const FIXED_STEP_SECONDS = 1 / 60;
export const GHOST_RUN_VERSION = 1;

export type DailyObjectiveId =
  | "ticket-quota"
  | "boot-quota"
  | "combo-target"
  | "rapid-response"
  | "patrol-distance";

export type DailyIncidentKind =
  | "meter-surge"
  | "repeat-alert"
  | "rush-hour"
  | "street-sweep"
  | "priority-expiry";

export type DailyObjective = {
  id: DailyObjectiveId;
  label: string;
  detail: string;
  target: number;
  unit: "tickets" | "boots" | "combo" | "response" | "meters";
};

export type DailyIncident = {
  kind: DailyIncidentKind;
  title: string;
  message: string;
  startsAtSeconds: number;
  durationSeconds: number;
};

export type DailyChallenge = {
  id: string;
  seed: number;
  date: string;
  title: string;
  briefing: string;
  objective: DailyObjective;
  bonus: number;
  incident: DailyIncident;
};

export type ObjectiveMetrics = {
  tickets: number;
  boots: number;
  maxCombo: number;
  firstTicketAtSeconds: number | null;
  distanceMeters: number;
};

export type ObjectiveEvaluation = {
  current: number;
  target: number;
  progress: number;
  complete: boolean;
};

export type GhostSample = {
  timeSeconds: number;
  x: number;
  z: number;
  rotation: number;
};

export type GhostRun = {
  version: typeof GHOST_RUN_VERSION;
  challengeId: string;
  rulesetVersion: number;
  score: number;
  samples: GhostSample[];
};

type ChallengeTemplate = Omit<DailyChallenge, "id" | "seed" | "date">;

const CHALLENGE_TEMPLATES: readonly ChallengeTemplate[] = [
  {
    title: "Red Meter Rally",
    briefing: "Dispatch expects a wave of expiring meters. Keep moving and clear the block.",
    objective: {
      id: "ticket-quota",
      label: "Issue 5 valid tickets",
      detail: "Only expired-meter tickets count.",
      target: 5,
      unit: "tickets",
    },
    bonus: 350,
    incident: {
      kind: "meter-surge",
      title: "Meter surge",
      message: "A meter bank just expired. Dispatch marked three fresh targets.",
      startsAtSeconds: 24,
      durationSeconds: 12,
    },
  },
  {
    title: "Repeat Roundup",
    briefing: "A repeat offender is circulating downtown. Scan plates and secure eligible cars.",
    objective: {
      id: "boot-quota",
      label: "Boot 2 repeat offenders",
      detail: "Scan and ticket each eligible vehicle before placing a boot.",
      target: 2,
      unit: "boots",
    },
    bonus: 500,
    incident: {
      kind: "repeat-alert",
      title: "Repeat offender alert",
      message: "Dispatch found a boot-eligible vehicle with an expired meter.",
      startsAtSeconds: 32,
      durationSeconds: 24,
    },
  },
  {
    title: "Combo Corridor",
    briefing: "Traffic is building. Chain correct tickets before the next meter cycle changes.",
    objective: {
      id: "combo-target",
      label: "Reach a 3× ticket combo",
      detail: "Keep valid tickets within the combo window.",
      target: 3,
      unit: "combo",
    },
    bonus: 300,
    incident: {
      kind: "rush-hour",
      title: "Rush hour",
      message: "Traffic speed is up for the next 18 seconds. Watch the crossings.",
      startsAtSeconds: 28,
      durationSeconds: 18,
    },
  },
  {
    title: "First on Scene",
    briefing: "Dispatch has a priority meter about to turn red. Reach a valid ticket quickly.",
    objective: {
      id: "rapid-response",
      label: "Ticket within 18 seconds",
      detail: "Your first valid ticket must land before the response window closes.",
      target: 1,
      unit: "response",
    },
    bonus: 250,
    incident: {
      kind: "priority-expiry",
      title: "Priority expiry",
      message: "The marked priority meter is now red. Its vehicle leaves soon.",
      startsAtSeconds: 7,
      durationSeconds: 22,
    },
  },
  {
    title: "Street Sweep",
    briefing: "Cover the district before street sweeping clears the parked vehicles.",
    objective: {
      id: "patrol-distance",
      label: "Patrol 110 meters",
      detail: "Only accepted movement through walkable streets counts.",
      target: 110,
      unit: "meters",
    },
    bonus: 400,
    incident: {
      kind: "street-sweep",
      title: "Street sweep inbound",
      message: "Unbooted vehicles will begin leaving early. Finish nearby checks now.",
      startsAtSeconds: 50,
      durationSeconds: 14,
    },
  },
] as const;

function seedFromText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function dateKeyFor(value: Date | string) {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) throw new TypeError("Daily challenge dates must use YYYY-MM-DD.");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new TypeError("Daily challenge date is not valid.");
    }
    return value;
  }

  if (!Number.isFinite(value.getTime())) throw new TypeError("Daily challenge date is not valid.");
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function dailyChallengeForDate(value: Date | string = new Date()): DailyChallenge {
  const date = dateKeyFor(value);
  const seed = seedFromText(`meter-mayhem:${date}:v${DAILY_RULESET_VERSION}`);
  const random = createSeededRandom(seed);
  const template = CHALLENGE_TEMPLATES[
    Math.floor(random() * CHALLENGE_TEMPLATES.length)
  ];
  return {
    ...template,
    objective: { ...template.objective },
    incident: { ...template.incident },
    id: `daily-${date}-v${DAILY_RULESET_VERSION}`,
    seed,
    date,
  };
}

export function evaluateObjective(
  objective: DailyObjective,
  metrics: ObjectiveMetrics,
): ObjectiveEvaluation {
  let current = 0;
  switch (objective.id) {
    case "ticket-quota":
      current = metrics.tickets;
      break;
    case "boot-quota":
      current = metrics.boots;
      break;
    case "combo-target":
      current = metrics.maxCombo;
      break;
    case "rapid-response":
      current =
        metrics.firstTicketAtSeconds !== null && metrics.firstTicketAtSeconds <= 18 ? 1 : 0;
      break;
    case "patrol-distance":
      current = metrics.distanceMeters;
      break;
  }

  const boundedCurrent = Math.max(0, Math.min(current, objective.target));
  return {
    current: boundedCurrent,
    target: objective.target,
    progress: objective.target > 0 ? boundedCurrent / objective.target : 1,
    complete: boundedCurrent >= objective.target,
  };
}

export function encodeGhostRun(run: GhostRun) {
  if (!isGhostRun(run)) throw new TypeError("Ghost run is not valid.");
  return JSON.stringify({
    v: run.version,
    c: run.challengeId,
    r: run.rulesetVersion,
    s: run.score,
    p: run.samples.map((sample) => [
      Math.round(sample.timeSeconds * 10),
      Math.round(sample.x * 100),
      Math.round(sample.z * 100),
      Math.round(sample.rotation * 1000),
    ]),
  });
}

export function decodeGhostRun(value: unknown): GhostRun | null {
  if (typeof value !== "string" || value.length < 10 || value.length > 120_000) return null;
  try {
    const parsed = JSON.parse(value) as {
      v?: unknown;
      c?: unknown;
      r?: unknown;
      s?: unknown;
      p?: unknown;
    };
    if (
      parsed.v !== GHOST_RUN_VERSION ||
      typeof parsed.c !== "string" ||
      !/^daily-\d{4}-\d{2}-\d{2}-v\d{1,3}$/u.test(parsed.c) ||
      !Number.isSafeInteger(parsed.r) ||
      Number(parsed.r) < 1 ||
      !Number.isSafeInteger(parsed.s) ||
      Number(parsed.s) < 0 ||
      Number(parsed.s) > 16_000 ||
      !Array.isArray(parsed.p) ||
      parsed.p.length < 2 ||
      parsed.p.length > 1_200
    ) {
      return null;
    }

    let previousTick = -1;
    const samples: GhostSample[] = [];
    for (const encoded of parsed.p) {
      if (
        !Array.isArray(encoded) ||
        encoded.length !== 4 ||
        encoded.some((number) => !Number.isSafeInteger(number))
      ) {
        return null;
      }
      const [tick, x, z, rotation] = encoded as number[];
      if (
        tick <= previousTick ||
        tick < 0 ||
        tick > SHIFT_DURATION_SECONDS * 10 + 1 ||
        Math.abs(x) > 10_000 ||
        Math.abs(z) > 10_000 ||
        Math.abs(rotation) > 10_000
      ) {
        return null;
      }
      previousTick = tick;
      samples.push({
        timeSeconds: tick / 10,
        x: x / 100,
        z: z / 100,
        rotation: rotation / 1000,
      });
    }

    const run: GhostRun = {
      version: GHOST_RUN_VERSION,
      challengeId: parsed.c,
      rulesetVersion: Number(parsed.r),
      score: Number(parsed.s),
      samples,
    };
    return isGhostRun(run) ? run : null;
  } catch {
    return null;
  }
}

export function sampleGhostAt(run: GhostRun, timeSeconds: number) {
  if (run.samples.length === 0) return null;
  if (timeSeconds <= run.samples[0].timeSeconds) return { ...run.samples[0] };
  const finalSample = run.samples[run.samples.length - 1];
  if (timeSeconds >= finalSample.timeSeconds) return { ...finalSample };

  let low = 0;
  let high = run.samples.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (run.samples[middle].timeSeconds <= timeSeconds) low = middle;
    else high = middle;
  }

  const first = run.samples[low];
  const second = run.samples[high];
  const span = second.timeSeconds - first.timeSeconds;
  const progress = span > 0 ? (timeSeconds - first.timeSeconds) / span : 0;
  let rotationDelta = (second.rotation - first.rotation + Math.PI) % (Math.PI * 2);
  if (rotationDelta < 0) rotationDelta += Math.PI * 2;
  rotationDelta -= Math.PI;
  return {
    timeSeconds,
    x: first.x + (second.x - first.x) * progress,
    z: first.z + (second.z - first.z) * progress,
    rotation: first.rotation + rotationDelta * progress,
  };
}

function isGhostRun(run: GhostRun) {
  return (
    run.version === GHOST_RUN_VERSION &&
    /^daily-\d{4}-\d{2}-\d{2}-v\d{1,3}$/u.test(run.challengeId) &&
    Number.isSafeInteger(run.rulesetVersion) &&
    run.rulesetVersion >= 1 &&
    Number.isSafeInteger(run.score) &&
    run.score >= 0 &&
    run.score <= 16_000 &&
    Array.isArray(run.samples) &&
    run.samples.length >= 2 &&
    run.samples.length <= 1_200 &&
    run.samples.every(
      (sample, index) =>
        Number.isFinite(sample.timeSeconds) &&
        sample.timeSeconds >= 0 &&
        sample.timeSeconds <= SHIFT_DURATION_SECONDS + 0.1 &&
        (index === 0 || sample.timeSeconds > run.samples[index - 1].timeSeconds) &&
        Number.isFinite(sample.x) &&
        Math.abs(sample.x) <= 100 &&
        Number.isFinite(sample.z) &&
        Math.abs(sample.z) <= 100 &&
        Number.isFinite(sample.rotation) &&
        Math.abs(sample.rotation) <= 10
    )
  );
}
