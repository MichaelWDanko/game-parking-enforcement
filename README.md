# Meter Mayhem

Meter Mayhem is a colorful 3D parking-enforcement game for the browser. Patrol
the block, ticket cars with expired meters, look up plates, and boot repeat
offenders before the 90-second shift ends.

Play the public game at
[meter-mayhem-parking.michaelwdanko.chatgpt.site](https://meter-mayhem-parking.michaelwdanko.chatgpt.site).

## Play

- Move with the arrow keys for the two-hand layout.
- Hold `Shift` to run.
- Press `Q` near a car to write a ticket.
- Press `W` to look up its plate.
- Press `E` to boot an eligible repeat offender after writing its ticket.

`WASD` remains available. Press `A`, `S`, or `D` to switch to that layout;
`F` looks up plates while `W` moves forward. The arrow keys switch back to the
`Q`/`W`/`E` action layout.

Standard game controllers are supported. Use the left stick or D-pad to move,
`A` to ticket, `X` to scan, `B` to boot, and a bumper or left-stick click to
run. Touch controls on small screens include a hold-to-run button.

Each UTC day has one seeded Daily Dispatch with a shared objective and a live
incident. The same challenge produces the same vehicle sequence in every city
and graphics mode. Five incident types can expire a bank of meters, reveal a
repeat offender, speed up rush-hour traffic, clear cars for street sweeping,
or mark a priority expiry.

The best eligible run for each daily challenge is saved on the current device
as a translucent replay ghost. Ghost data uses compact, validated IndexedDB
records. It never leaves the device.

Choose one of three fictional patrol cities before each shift:

- Port Alder uses brick, harbor blue, and autumn colors.
- Ironlake uses steel, lake teal, and warm copper colors.
- Juniper Ridge uses terracotta, alpine green, and clear cobalt colors.

Every city uses the same streets, parking spaces, traffic rules, meter timing,
90-second shift, scoring, and leaderboard. The choice changes only the city
name and visual palette. The selected city is saved on the current device.

Enter an officer name before starting a shift. Full, uninterrupted shifts are
added to the daily top-10 board. The result screen can switch between Today
and All time. Ending early or leaving the tab creates a practice result that
does not change the board or personal-best ghost. Scores use the ChatGPT Sites
D1 database; no separate server or third-party database is required.

## Graphics and world loading

Choose Auto, Performance, Balanced, or Quality before a shift or from the
in-game graphics menu. The choice is saved on the current device. Each mode
changes render resolution, shadows, view distance, and street detail. All ten
traffic vehicles remain active in every mode so graphics settings never alter
collision rules or challenge difficulty.

The first three city blocks load before the home screen appears. The outer
blocks load as Officer Graham approaches them. All city themes reuse the world
data in small JSON chunks under `public/world/downtown`, so color choices do
not duplicate geometry or increase the initial world download.

Main Street now connects to Civic Avenue, Garden Lane, and Garden Plaza. Cars
park and travel in both street directions. Buildings that cross the camera
sightline hide until the officer is visible again. Moving cars brake for the
officer, and vehicle clearance keeps the officer and cars from clipping.

## Scoring

- Valid ticket: 100 points, with a quick-ticket combo bonus.
- Valid repeat-offender boot: 250 points.
- Ticket before meter expiration: 75-point penalty.
- Invalid boot: 150-point penalty.
- Daily Dispatch objective: 250–500 points, depending on the objective.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```bash
npm test
npm run lint
```

## Hosting

The app builds for ChatGPT Sites with `npm run build`. It does not need player
accounts or a separate backend. The Sites runtime serves the score API and
provides the D1 database. Publish the Site with access set to **Anyone on the
internet** so visitors can play without ChatGPT workspace access.

Set `SCOREBOARD_SECRET` as a secret production environment value in Sites.
The score API uses it to sign the daily challenge, ruleset, and 90-second shift
session, and to hash rate-limit keys. It never stores a visitor's raw network
address. The API keeps the top 500 results for each challenge and limits each
network source to 10 saved scores per hour.
