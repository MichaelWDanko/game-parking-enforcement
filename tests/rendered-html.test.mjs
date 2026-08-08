import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  forwardLoopDistance,
  nearestTrafficGap,
  TRAFFIC_BRAKE_DISTANCE,
  trafficVehiclesOverlap,
} from "../app/traffic-collision.ts";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Meter Mayhem loading screen", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Meter Mayhem — Parking Enforcement<\/title>/i);
  assert.match(html, /CITY SERVICES PRESENTS/);
  assert.match(html, /Officer Graham is checking the meter map/);
  assert.match(html, /Colorful 3D city game view/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Starter Project/i);
});

test("includes the full game loop and accessible controls", async () => {
  const [game, css, packageJson] = await Promise.all([
    readFile(new URL("../app/parking-game.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/parking-game.module.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"name": "meter-mayhem"/);
  assert.match(packageJson, /"three":/);
  assert.match(game, /"loading" \| "home" \| "playing" \| "gameover"/);
  assert.match(game, /Write ticket/);
  assert.match(game, /Look up plate/);
  assert.match(game, /Place boot/);
  assert.match(game, /OFFICER GRAHAM NEEDS YOU/);
  assert.match(game, /Will you help me patrol/);
  assert.match(game, /data-testid="final-score"/);
  assert.match(game, /aria-label="Touch controls"/);
  assert.match(game, /meter-mayhem-best:/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(game, /SkeletonPreview|react-loading-skeleton/);
});

test("keeps score changes tied to enforcement rules", async () => {
  const game = await readFile(
    new URL("app/parking-game.tsx", projectRoot),
    "utf8",
  );

  assert.match(game, /score \+= points/);
  assert.match(game, /score \+= 250/);
  assert.match(game, /score = Math\.max\(0, score - 75\)/);
  assert.match(game, /score = Math\.max\(0, score - 150\)/);
  assert.match(game, /if \(!car\.lookedUp\)/);
  assert.match(game, /else if \(!car\.ticketed\)/);
  assert.match(game, /else if \(car\.priors < 3\)/);
});

test("offers saved graphics modes and streams the city in chunks", async () => {
  const [game, manifestText] = await Promise.all([
    readFile(new URL("app/parking-game.tsx", projectRoot), "utf8"),
    readFile(new URL("public/world/downtown/manifest.json", projectRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.id),
    ["market", "arts", "civic", "arcade", "gardens"],
  );
  assert.equal(manifest.chunks.filter((chunk) => chunk.initial).length, 3);
  assert.match(game, /"auto" \| "performance" \| "balanced" \| "quality"/);
  assert.match(game, /meter-mayhem-graphics/);
  assert.match(game, /fetch\(assetPath\(definition\.file\)\)/);
  assert.match(game, /blocks ready/);
  assert.match(game, /Graphics settings/);
});

test("offers three saved city palettes without changing layout or difficulty", async () => {
  const [game, cityThemes] = await Promise.all([
    readFile(new URL("app/parking-game.tsx", projectRoot), "utf8"),
    readFile(new URL("app/city-themes.ts", projectRoot), "utf8"),
  ]);

  assert.match(cityThemes, /"port-alder"/);
  assert.match(cityThemes, /"ironlake"/);
  assert.match(cityThemes, /"juniper-ridge"/);
  assert.match(cityThemes, /name: "Port Alder"/);
  assert.match(cityThemes, /name: "Ironlake"/);
  assert.match(cityThemes, /name: "Juniper Ridge"/);
  assert.doesNotMatch(cityThemes, /Boston|Chicago|Denver/);
  assert.doesNotMatch(cityThemes, /difficulty|shiftSeconds|trafficCount/i);
  assert.match(game, /Choose patrol city/);
  assert.match(game, /Same streets and challenge/);
  assert.match(game, /meter-mayhem-city/);
  assert.match(game, /applyCityRef/);
  assert.match(game, /fetch\(assetPath\("\/world\/downtown\/manifest\.json"\)\)/);
  assert.match(game, /gameTime >= SHIFT_DURATION_SECONDS/);
  assert.match(game, /SHIFT_DURATION_SECONDS - gameTime/);
});

test("opens connected side streets and keeps the officer visible", async () => {
  const game = await readFile(
    new URL("app/parking-game.tsx", projectRoot),
    "utf8",
  );

  assert.match(game, /name: "Civic Avenue"/);
  assert.match(game, /name: "Garden Lane"/);
  assert.match(game, /plaza\.name = "Garden Plaza"/);
  assert.match(game, /const isWalkable = \(x: number, z: number\)/);
  assert.match(game, /addParkingSpot\("x", side, x\)/);
  assert.match(game, /spot\.axis === "x"/);
  assert.match(game, /cameraRaycaster\.intersectObjects\(cameraOccluders, true\)/);
  assert.match(game, /group\.visible = !activeOccluders\.has\(group\)/);
  assert.match(game, /28 \+ \(index % 3\) \* 2\.5/);
  assert.doesNotMatch(game, /clamp\(officer\.root\.position\.x, -11\.2, 11\.2\)/);
});

test("supports the two-hand Q W E layout and keeps WASD available", async () => {
  const game = await readFile(
    new URL("app/parking-game.tsx", projectRoot),
    "utf8",
  );

  assert.match(game, /keyboardScheme: KeyboardScheme = "arrows"/);
  assert.match(game, /event\.code === "KeyQ"\) doAction\("ticket"\)/);
  assert.match(game, /event\.code === "KeyW" && keyboardScheme === "arrows"/);
  assert.match(game, /doAction\("lookup"\);\s*keysRef\.current\.delete\("KeyW"\);\s*return;/);
  assert.match(game, /event\.code === "KeyE"\) doAction\("boot"\)/);
  assert.match(game, /event\.code === "KeyF"\) doAction\("lookup"\)/);
  assert.match(game, /\["KeyA", "KeyS", "KeyD"\]\.includes\(event\.code\)/);
  assert.match(game, /event\.code\.startsWith\("Arrow"\)[\s\S]*keysRef\.current\.delete\("KeyW"\)/);
  assert.match(game, /<kbd>Q<\/kbd>/);
  assert.match(game, /<kbd>W<\/kbd>/);
  assert.match(game, /<kbd>E<\/kbd>/);
});

test("brakes moving cars and blocks vehicle clipping", async () => {
  const game = await readFile(
    new URL("app/parking-game.tsx", projectRoot),
    "utf8",
  );

  assert.match(game, /cruiseSpeed: number/);
  assert.match(game, /const shouldBrakeForOfficer/);
  assert.match(game, /const officerBlocksVehiclePath/);
  assert.match(game, /const shouldBrakeForTraffic/);
  assert.match(game, /const trafficClearsVehicle/);
  assert.match(game, /brakingForOfficer \|\| brakingForTraffic/);
  assert.match(game, /blockedOnPath \|\| blockedAtWrap \|\| blockedByTraffic/);
  assert.match(game, /braking \? 0 : traffic\.cruiseSpeed \* trafficSpeedMultiplier/);
  assert.match(game, /traffic\.speed = 0/);
  assert.match(game, /driveRate: number/);
  assert.match(game, /car\.phaseTime \+ dt \* car\.driveRate/);
  assert.match(game, /car\.driveRate = 0/);
  assert.match(game, /const canOfficerStandAt/);
  assert.match(game, /canOfficerStandAt\(nextX, nextZ\)/);
});

test("keeps traffic separated in lanes, intersections, and loop wrapping", () => {
  const northbound = { axis: "z", x: -1.9, z: 54 };
  const wrappedLeader = { axis: "z", x: -1.9, z: -56 };
  const oppositeLane = { axis: "z", x: 1.9, z: -56 };

  assert.equal(forwardLoopDistance(54, -56, 1), 6);
  assert.equal(nearestTrafficGap(northbound, 1, [wrappedLeader]), 6);
  assert.ok(nearestTrafficGap(northbound, 1, [wrappedLeader]) < TRAFFIC_BRAKE_DISTANCE);
  assert.equal(nearestTrafficGap(northbound, 1, [oppositeLane]), Number.POSITIVE_INFINITY);

  assert.equal(
    trafficVehiclesOverlap(
      { axis: "z", x: -1.9, z: -56 },
      { axis: "z", x: -1.9, z: -53 },
    ),
    true,
  );
  assert.equal(
    trafficVehiclesOverlap(
      { axis: "z", x: -1.9, z: 0 },
      { axis: "x", x: 0, z: -1.9 },
    ),
    true,
  );
  assert.equal(
    trafficVehiclesOverlap(
      { axis: "z", x: -1.9, z: -56 },
      oppositeLane,
    ),
    false,
  );
});

test("stores named global scores through the Sites D1 binding", async () => {
  const [game, route, sessionRoute, server, schema, hosting] = await Promise.all([
    readFile(new URL("app/parking-game.tsx", projectRoot), "utf8"),
    readFile(new URL("app/api/scores/route.ts", projectRoot), "utf8"),
    readFile(new URL("app/api/scores/session/route.ts", projectRoot), "utf8"),
    readFile(new URL("app/api/scores/server.ts", projectRoot), "utf8"),
    readFile(new URL("db/schema.ts", projectRoot), "utf8"),
    readFile(new URL(".openai/hosting.json", projectRoot), "utf8"),
  ]);

  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(schema, /sqliteTable\(\s*"scores"/);
  assert.match(schema, /uniqueIndex\("scores_run_id_unique"\)/);
  assert.match(schema, /sqliteTable\(\s*"score_rate_limits"/);
  assert.match(schema, /score_rate_limits_source_created_idx/);
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(sessionRoute, /issueShiftSession\(request, payload\)/);
  assert.match(server, /SCOREBOARD_SECRET/);
  assert.match(server, /CF-Connecting-IP/);
  assert.match(server, /minimumSessionAgeSeconds:\s*75/);
  assert.match(server, /maximumSessionAgeSeconds:\s*600/);
  assert.match(server, /bodyBytes:\s*2_048/);
  assert.match(route, /typeof value === "number"/);
  assert.match(route, /"runId",\s*"issuedAt",\s*"token"/);
  assert.match(route, /validated\.runId !== session\.runId/);
  assert.match(route, /validated\.issuedAt !== session\.issuedAt/);
  assert.match(route, /validated\.challengeId !== session\.challengeId/);
  assert.match(route, /expectedDailyChallenge\(challengeId\)/);
  assert.match(route, /entryId:\s*String\(row\.id\)/);
  assert.doesNotMatch(route, /runId:\s*row\.runId/);
  assert.match(server, /maxTickets:\s*24/);
  assert.match(route, /score_rate_limits/);
  assert.match(route, /maxAcceptedPerHour/);
  assert.match(route, /LIMIT -1 OFFSET \?/);
  assert.match(route, /maximumPossibleScore/);
  assert.doesNotMatch(route, /Number\(payload\.(?:score|tickets|boots)\)/);
  assert.match(game, /data-testid="player-name"/);
  assert.match(game, /aria-label="Global leaderboard"/);
  assert.match(game, /meter-mayhem-player-name/);
  assert.match(game, /fetchWithTimeout\("\/api\/scores\/session"/);
  assert.match(game, /runId: gameResult\.runId/);
  assert.match(game, /issuedAt: gameResult\.issuedAt/);
  assert.match(game, /token: gameResult\.token/);
  assert.match(game, /challengeId: gameResult\.challengeId/);
  assert.match(game, /objectiveBonus: gameResult\.objectiveBonus/);
  assert.match(game, /fetchWithTimeout\("\/api\/scores"/);
  assert.match(game, /entry\.entryId === lastSavedScore\.entryId/);
  assert.match(game, /controller\.abort\(\)/);
});

test("runs deterministic daily dispatches with fair traffic and local ghosts", async () => {
  const [game, dispatch, ghostStore, feedback] = await Promise.all([
    readFile(new URL("app/parking-game.tsx", projectRoot), "utf8"),
    readFile(new URL("app/daily-dispatch.ts", projectRoot), "utf8"),
    readFile(new URL("app/ghost-store.ts", projectRoot), "utf8"),
    readFile(new URL("app/game-feedback.ts", projectRoot), "utf8"),
  ]);

  assert.match(dispatch, /createSeededRandom/);
  assert.match(dispatch, /FIXED_STEP_SECONDS = 1 \/ 60/);
  assert.match(dispatch, /"meter-surge"/);
  assert.match(dispatch, /"repeat-alert"/);
  assert.match(dispatch, /"rush-hour"/);
  assert.match(dispatch, /"street-sweep"/);
  assert.match(dispatch, /"priority-expiry"/);
  assert.match(game, /while \(simulationAccumulator >= FIXED_STEP_SECONDS\)/);
  assert.doesNotMatch(game, /Math\.random\(\)/);
  assert.doesNotMatch(game, /traffic\.group\.visible/);
  assert.match(game, /Personal best ghost/);
  assert.match(game, /document\.addEventListener\("visibilitychange"/);
  assert.match(game, /gamepad\?\.buttons\[15\]/);
  assert.match(game, />Run<\/button>/);
  assert.match(ghostStore, /indexedDB/);
  assert.match(feedback, /createPanner\(\)/);
  assert.match(feedback, /vibrationActuator/);
});

test("briefs the objective before starting and keeps gameplay reminders compact", async () => {
  const game = await readFile(
    new URL("app/parking-game.tsx", projectRoot),
    "utf8",
  );
  const requestBriefingStart = game.indexOf("const requestBriefing = () => {");
  const confirmShiftStart = game.indexOf("const start = async () => {");
  const actionBridgeStart = game.indexOf("const act = (kind: ActionKind)");

  assert.ok(requestBriefingStart >= 0);
  assert.ok(confirmShiftStart > requestBriefingStart);
  assert.ok(actionBridgeStart > confirmShiftStart);

  const requestBriefing = game.slice(requestBriefingStart, confirmShiftStart);
  const confirmShift = game.slice(confirmShiftStart, actionBridgeStart);
  assert.doesNotMatch(requestBriefing, /fetchWithTimeout\("\/api\/scores\/session"/);
  assert.match(requestBriefing, /setBriefingOpen\(true\)/);
  assert.match(confirmShift, /startAttemptRef\.current = true/);
  assert.match(confirmShift, /fetchWithTimeout\("\/api\/scores\/session"/);
  assert.match(confirmShift, /if \(startGame\) startGame\(\)/);

  assert.match(game, /data-testid="pre-shift-briefing"/);
  assert.match(game, /aria-labelledby="shift-briefing-title"/);
  assert.match(game, /The timer starts only after you press Start shift/);
  assert.match(game, /data-testid="confirm-shift"/);
  assert.match(game, /Review shift briefing/);
  assert.match(game, /data-testid="objective-reminder"/);
  assert.match(game, /data-testid="objective-toggle"/);
  assert.match(game, /aria-expanded=\{objectiveOpen\}/);
  assert.match(game, /aria-controls="objective-details"/);
  assert.match(game, /role="progressbar"/);
  assert.match(game, /hidden=\{!objectiveOpen\}/);
  assert.match(game, /toast && <div className=\{styles\.toast\} role="status"/);
  assert.doesNotMatch(game, /setToast\(dailyChallenge\.objective\.label\)/);
});
