import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(game, /window\.localStorage\.setItem\("meter-mayhem-best"/);
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
  assert.match(game, /city blocks ready/);
  assert.match(game, /Graphics settings/);
});
