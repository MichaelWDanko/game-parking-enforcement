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

Touch controls appear on small screens. The best score is saved on the current
device.

Enter an officer name before starting a shift. Completed shifts are added to
the global top-10 board. Global scores use the ChatGPT Sites D1 database; no
separate server or third-party database is required.

## Graphics and world loading

Choose Auto, Performance, Balanced, or Quality before a shift or from the
in-game graphics menu. The choice is saved on the current device. Each mode
changes render resolution, shadows, view distance, traffic, and street detail.

The first three city blocks load before the home screen appears. The outer
blocks load as Officer Graham approaches them. World data lives in small JSON
chunks under `public/world/downtown`, so the game can grow without one large
initial download.

Main Street now connects to Civic Avenue, Garden Lane, and Garden Plaza. Cars
park and travel in both street directions. Buildings that cross the camera
sightline hide until the officer is visible again. Moving cars brake for the
officer, and vehicle clearance keeps the officer and cars from clipping.

## Scoring

- Valid ticket: 100 points, with a quick-ticket combo bonus.
- Valid repeat-offender boot: 250 points.
- Ticket before meter expiration: 75-point penalty.
- Invalid boot: 150-point penalty.

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
The score API uses it to sign 90-second shift sessions and hash rate-limit
keys. It never stores a visitor's raw network address. The API keeps only the
top 500 results and limits each network source to 10 saved scores per hour.
