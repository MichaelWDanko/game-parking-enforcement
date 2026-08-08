import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_RULESET_VERSION,
  GHOST_RUN_VERSION,
  createSeededRandom,
  dailyChallengeForDate,
  decodeGhostRun,
  encodeGhostRun,
  evaluateObjective,
  sampleGhostAt,
} from "../app/daily-dispatch.ts";

const emptyMetrics = {
  tickets: 0,
  boots: 0,
  maxCombo: 0,
  firstTicketAtSeconds: null,
  distanceMeters: 0,
};

const objectives = {
  tickets: {
    id: "ticket-quota",
    label: "Ticket quota",
    detail: "Issue tickets.",
    target: 5,
    unit: "tickets",
  },
  boots: {
    id: "boot-quota",
    label: "Boot quota",
    detail: "Place boots.",
    target: 2,
    unit: "boots",
  },
  combo: {
    id: "combo-target",
    label: "Combo target",
    detail: "Build a combo.",
    target: 3,
    unit: "combo",
  },
  response: {
    id: "rapid-response",
    label: "Rapid response",
    detail: "Ticket quickly.",
    target: 1,
    unit: "response",
  },
  distance: {
    id: "patrol-distance",
    label: "Patrol distance",
    detail: "Cover the district.",
    target: 110,
    unit: "meters",
  },
};

const ghostRun = {
  version: GHOST_RUN_VERSION,
  challengeId: `daily-2026-08-07-v${DAILY_RULESET_VERSION}`,
  rulesetVersion: DAILY_RULESET_VERSION,
  score: 1_250,
  samples: [
    { timeSeconds: 0, x: 0, z: 1.25, rotation: 3 },
    { timeSeconds: 0.5, x: 2.5, z: -1.25, rotation: -3 },
    { timeSeconds: 1, x: 5, z: -3.5, rotation: -2.5 },
  ],
};

test("daily challenges are deterministic UTC contracts", () => {
  const first = dailyChallengeForDate("2026-08-07");
  const second = dailyChallengeForDate("2026-08-07");
  const fromDate = dailyChallengeForDate(new Date("2026-08-07T23:59:59.999Z"));

  assert.deepEqual(first, second);
  assert.deepEqual(first, fromDate);
  assert.equal(first.id, `daily-2026-08-07-v${DAILY_RULESET_VERSION}`);
  assert.equal(first.date, "2026-08-07");
  assert.ok(Number.isSafeInteger(first.seed));
  assert.notDeepEqual(first, dailyChallengeForDate("2026-08-08"));
  assert.throws(() => dailyChallengeForDate("08/07/2026"), /YYYY-MM-DD/u);
  assert.throws(() => dailyChallengeForDate("2026-02-30"), /not valid/u);
});

test("daily rotation reaches every objective and incident template", () => {
  const objectiveIds = new Set();
  const incidentKinds = new Set();
  const start = Date.UTC(2026, 0, 1);

  for (let day = 0; day < 120; day++) {
    const challenge = dailyChallengeForDate(new Date(start + day * 86_400_000));
    objectiveIds.add(challenge.objective.id);
    incidentKinds.add(challenge.incident.kind);
  }

  assert.deepEqual(
    [...objectiveIds].sort(),
    ["boot-quota", "combo-target", "patrol-distance", "rapid-response", "ticket-quota"],
  );
  assert.deepEqual(
    [...incidentKinds].sort(),
    ["meter-surge", "priority-expiry", "repeat-alert", "rush-hour", "street-sweep"],
  );
});

test("seeded random streams repeat without sharing mutable state", () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  const third = createSeededRandom(43);
  const firstSequence = Array.from({ length: 8 }, () => first());

  assert.deepEqual(firstSequence, Array.from({ length: 8 }, () => second()));
  assert.notDeepEqual(firstSequence, Array.from({ length: 8 }, () => third()));
  assert.ok(firstSequence.every((value) => value >= 0 && value < 1));
});

test("evaluates ticket, boot, combo, response, and distance objectives", () => {
  assert.deepEqual(evaluateObjective(objectives.tickets, { ...emptyMetrics, tickets: 3 }), {
    current: 3,
    target: 5,
    progress: 0.6,
    complete: false,
  });
  assert.equal(
    evaluateObjective(objectives.tickets, { ...emptyMetrics, tickets: 8 }).current,
    5,
  );
  assert.equal(
    evaluateObjective(objectives.boots, { ...emptyMetrics, boots: 2 }).complete,
    true,
  );
  assert.equal(
    evaluateObjective(objectives.combo, { ...emptyMetrics, maxCombo: 3 }).complete,
    true,
  );
  assert.equal(
    evaluateObjective(objectives.response, {
      ...emptyMetrics,
      firstTicketAtSeconds: 18,
    }).complete,
    true,
  );
  assert.equal(
    evaluateObjective(objectives.response, {
      ...emptyMetrics,
      firstTicketAtSeconds: 18.01,
    }).complete,
    false,
  );
  assert.deepEqual(
    evaluateObjective(objectives.distance, { ...emptyMetrics, distanceMeters: 55 }),
    { current: 55, target: 110, progress: 0.5, complete: false },
  );
});

test("ghost codec round-trips bounded, quantized replay samples", () => {
  const encoded = encodeGhostRun(ghostRun);
  const decoded = decodeGhostRun(encoded);

  assert.ok(encoded.length < 200);
  assert.deepEqual(decoded, ghostRun);
  assert.throws(
    () => encodeGhostRun({ ...ghostRun, samples: ghostRun.samples.slice(0, 1) }),
    /not valid/u,
  );
});

test("ghost decoder rejects corrupt, oversized, and unsafe payloads", () => {
  const valid = JSON.parse(encodeGhostRun(ghostRun));

  assert.equal(decodeGhostRun(null), null);
  assert.equal(decodeGhostRun("{broken"), null);
  assert.equal(decodeGhostRun("x".repeat(120_001)), null);
  assert.equal(decodeGhostRun(JSON.stringify({ ...valid, v: 99 })), null);
  assert.equal(decodeGhostRun(JSON.stringify({ ...valid, c: "classic" })), null);
  assert.equal(decodeGhostRun(JSON.stringify({ ...valid, s: 16_001 })), null);
  assert.equal(decodeGhostRun(JSON.stringify({ ...valid, p: [[0, 0, 0, 0]] })), null);
  assert.equal(
    decodeGhostRun(JSON.stringify({ ...valid, p: [[0, 0, 0, 0], [0, 1, 1, 1]] })),
    null,
  );
  assert.equal(
    decodeGhostRun(JSON.stringify({ ...valid, p: [[0, 0, 0, 0], [1, 10_001, 0, 0]] })),
    null,
  );
});

test("ghost playback interpolates position and takes the shortest rotation path", () => {
  const before = sampleGhostAt(ghostRun, -1);
  const middle = sampleGhostAt(ghostRun, 0.25);
  const after = sampleGhostAt(ghostRun, 100);

  assert.deepEqual(before, ghostRun.samples[0]);
  assert.equal(middle?.timeSeconds, 0.25);
  assert.equal(middle?.x, 1.25);
  assert.equal(middle?.z, 0);
  assert.ok(Math.abs((middle?.rotation ?? 0) - Math.PI) < 0.001);
  assert.deepEqual(after, ghostRun.samples.at(-1));
});
