# COLONY — Seven Days

An original isometric survival-engineering game for the browser. Six survivors, a dead industrial compound, and seven days to make it work: scavenge, repair, dismantle, repurpose, build, and keep everyone fed, watered and alive through a storm.

Runs on desktop and phones (iPhone Safari included), and can be added to the home screen as an app (Share → Add to Home Screen). No accounts, servers or external assets — everything is drawn procedurally and saved locally in the browser.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check and production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Simulation unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run e2e` | Browser end-to-end run at desktop and iPhone sizes (needs `npm run build` first and Playwright's Chromium) |
| `npm run check` | typecheck + lint + tests + build |
| `node scripts/icons.mjs` | Regenerate the home-screen PNG icons from `public/icon.svg` |
| `npm run build:single` | One self-contained HTML file (`dist-single/`), plus a page fragment for publishing as a claude.ai Artifact |

`dist/` is a static site; it can be hosted anywhere (Vercel, Netlify, GitHub Pages). Asset paths are relative.

## How to play

- **Tap a machine, heap, planter or structure** to see its condition, what's wrong, and what you can do. Every option lists materials (have/need), labour time, the skill involved, what it yields, and what you lose.
- **Repair** restores function. **Dismantle** recovers parts and destroys the object for good. **Repurpose** turns it into something else (pull the forklift's engine and fit it to the generator; lay the pipe stack as irrigation; fit filter cartridges).
- **Tap a survivor** (in the world or on their card) to select them. Jobs you queue while someone is selected go to them; tapping the ground walks them there. Otherwise the best free, skilled hand takes the job.
- Workers really do the work: they walk to the supply cache to collect materials and a tool kit, walk to the job, work at a speed set by skill and condition, and haul anything recovered back to storage.
- **Build** places cots, planters, rain catchers, filters, a purifier, storage racks, a wind turbine and lamps. Placement is validated (inside the fence, unobstructed, never cuts off access).
- **Expedition** opens a regional map: pick a destination, up to three survivors, and supplies (water, food, tools, meds). Teams travel, search, may face a decision on site, risk injury, and return with real cargo. Locations deplete.
- **Speed**: pause / 1× / 3× / 9×. Decisions pause time automatically.

**Controls** — drag to pan, pinch or scroll to zoom. Keyboard: `Space` pause, `1`–`3` speed, `WASD`/arrows pan, `B` build, `J` jobs, `E` expeditions, `L` log, `Esc` close.

## The scenario

Start: Day 1, 07:00. Food for two days, water for one, a seized generator, a dead well pump, a leaking tank, overgrown planters. A storm hits on Day 5 (exact timing via the radio, travellers, or the barometer ~30 h out). On Day 3 a family of travellers arrives at the gate.

Primary objectives: keep everyone alive, establish reliable power (12 powered hours), safe water (40 L treated), a food supply (3 planters growing or 10 rations harvested), weather the storm, and reach the end of Day 7 with a functioning settlement. Optional: fit the salvaged engine, earn the Kesslers' trust, take no storm damage, run two lamps.

The end screen grades the settlement (Thriving / Functioning / Holding on / Abandoned / Settlement lost) and lists every death and its cause, system status, storm damage and key choices.

## Catastrophes

A new game opens with **Choose your catastrophe**. Pick one of six, **Random scenario**, or **Custom sandbox**, and a difficulty (Forgiving / Standard / Brutal). Each catastrophe changes the starting world, feeds modifiers into the core systems, runs its own hazards, and ends in its own climax.

| Scenario | Kind | What changes in play | Climax |
| --- | --- | --- | --- |
| **Storm Season** | Original | The original seven days, unchanged. Older saves load as this scenario. | The storm |
| **Aftershock** | Natural disaster | Sol starts pinned under rubble (dig him out or he dies). Rubble blocks the yard and clearing it yields scrap; a working forklift speeds it up. Aftershocks (warned ~75 min ahead) damage unbraced machines. The market road is cut and the ridge road is unstable. The storm floods the low ground (drowned crops, contaminated well) unless you stack two sandbag levees. Wildfire embers can set things alight. | The flood |
| **Blackout** | Societal collapse | Almost no fuel and thin loot everywhere. The Ridge Crew demand tribute; their threat grows over time and they raid weak settlements at night. Low morale makes people leave. Traders and drifters arrive more often, and a drifter may be a thief. Barricades and the gate make up your defence. | The Ridge Crew attack |
| **The Fever** | Pandemic | A contagious fever spreads between people who work, eat and sleep close together; one survivor starts infected. Quarantine (from the survivor panel) stops the spread but costs labour. Isolation beds seal it off, and a powered one makes treatment far more effective. Medical supplies are the bottleneck. Strangers and the market pharmacy carry infection. | The storm |
| **Black Rain** | Nuclear fallout | Outdoor radiation adds to each person's dose (indoors blocks ~92%); radiation sickness slows work and drains health. Radiation fades over days but rain washes it down. Boiling no longer makes water safe; filters and the purifier do. Uncovered crops grow at half speed. The ridge is downwind and hot. The medic can bring doses down with medical supplies. | The black rain |
| **The Infected** | Zombie outbreak | The infected mass outside the fence and are drawn by noise: the generator, work and lights. Too many for your defence and they break through, hurting people. Injuries can be bites, which turn into a fatal fever within about two days unless treated (2 medical supplies; the medic is most reliable). Expeditions are riskier. | The horde |

**Climaxes** are decision events. For a raid you can hold the gate, pay them off, or call in the Kesslers if they trust you. For the horde you can hold the fence, go dark and silent, or send a runner to lure them away. The outcome depends on your defence rating, and you see it before you commit.

### Event director

On top of each scenario, a seeded **event director** checks the world every hour and may start a secondary crisis or an opportunity. Every event has prerequisites, a weight, a cooldown and a cap. Most crises **warn first** and only strike if the cause is still there when the warning runs out, so you can head them off:

- **Squall:** more likely when things are already damaged.
- **Bad water:** after people drink untreated water; averted if treatment starts.
- **Generator failing:** when its condition is low; servicing averts it, otherwise it may catch fire.
- **Blocked route** and **changing conditions at a location**.
- **Aftershock** and **wildfire embers**.
- **Night raid** and **fence breach**.
- **Someone wants to leave:** low morale; better conditions avert it.
- **A stranger at the gate:** with scenario-specific hidden risks.
- **A trader's cart** and a **relief broadcast:** needs the radio.

The director rests at least 14 hours between crises and eases off when the settlement is already struggling. Current warnings, conditions (radiation, infected, noise, raider threat, flood, defence) and location hazards are in the **World** panel; a pill under the objective line shows the most pressing one.

### Sandbox

**Custom sandbox** lets you set the main catastrophe, layer others on top, and choose starting supplies, how often crises happen, and difficulty. In a sandbox game the World panel adds controls to:

- add another catastrophe mid-game;
- adjust radiation, the infected, raider threat and floodwater;
- trigger director events;
- call a squall, rain or clear skies;
- drop in supplies.

Every control goes through a validated, clamped command, so it can only create states the simulation itself could reach, and the result saves and loads normally. Survival games refuse these commands.

## How the systems connect

- **Power**: a diesel generator (condition, fuel, wear, servicing) and an optional wind turbine feed consumers by priority (pump → purifier → lamps → workbench → radio). A repaired battery bank stores surplus; with it, the generator runs on a charge/discharge cycle to save fuel. Shortfalls shut equipment off.
- **Water**: the well pump (needs power) fills untreated storage, capped by the tank (40 L leaking, 300 L patched). Rain catchers collect rain. Sand filters (5–10 L/h, no power) and the purifier (15 L/h, 2 kW) produce drinking water. Drinking untreated water can make people sick.
- **Food**: rations are eaten twice a day. Planters take a ration as seed stock, need watering (by hand or via irrigation from untreated storage) and yield after ~36 h.
- **Survivors**: health, hydration, hunger, energy, morale, illness and injury. Skills (0–3) change work speed; unskilled hands on machinery occasionally get hurt. Each has a trait with a real effect (e.g. the Tinkerer recovers extra parts, the Night Owl works late, the Empath lifts morale). Beds matter. A medic treats injuries with medical supplies.
- **Storm**: at its peak it damages every exposed, unreinforced object it touches (generator and pump flood, battery bank shorts, tank splits, crops flatten, turbine and lamps break, gate is wrenched loose). Reinforcing beforehand prevents it. Rain catchers and tanks fill up.
- **The Kesslers**: trade, give freely, share a meal (needs the radio or a calm voice), or turn them away. Consequences play out later: a skilled mechanic may join, a supply crate may arrive, or raiders may come through a broken gate. Raiding their stockroom at the market changes the encounter.

## Architecture

```
src/
  sim/            pure, deterministic simulation (no DOM)
    types.ts        typed game state, commands
    world.ts        map, tiles, buildings, occupancy, A* pathfinding
    inventory.ts    single authoritative store + ledger (produce/consume/take/deposit)
    actions.ts      object catalogue, repair/dismantle/repurpose actions, blueprints
    jobs.ts         job board: queueing, assignment, staging materials, completion, hauling
    survivors.ts    needs, movement, need-driven behaviour, job execution
    infrastructure.ts power network, water chain, crops, weather, routine jobs
    expeditions.ts  locations, team dispatch, search, decisions, cargo
    events.ts       conditional events (storm, travellers, warnings) and decisions
    scenario.ts     objectives, immediate goal, end evaluation
    catastrophes.ts catastrophe definitions, modifiers, world tick (radiation, noise, horde, threat, flood, fire), climaxes
    director.ts     event director: prerequisites, weights, cooldowns, warnings, mercy
    sandbox.ts      validated sandbox interventions
    setup.ts        roster, initial compound, weather schedule
    save.ts         versioned, validated save/load
    sim.ts          fixed-step `step()`, command `dispatch()`, placement rules
  render/         canvas isometric renderer: ground cache, procedural sprites,
                  depth sorting, particles, weather, lighting, overlays, picking
  ui/             DOM HUD, panels, modals, icons, portraits
  main.ts         game loop (fixed 1-minute steps, frame-rate independent), input, autosave
tests/            Vitest suites + a scripted "bot" player
scripts/e2e.mjs   Playwright run through the real UI
```

The simulation advances in fixed one-game-minute steps regardless of frame rate or speed; rendering interpolates survivor positions between steps. All randomness comes from a seeded RNG stored in the save, so a seed plus commands reproduces a game exactly. Every resource change goes through the inventory module and is recorded in a ledger; tests assert that the world total always equals the starting total plus production minus consumption, across a full seven-day run.

Saves are stored in `localStorage` (`colony.save`) every 15 s and when the page is hidden. Corrupt, structurally invalid or other-version saves are rejected and a fresh game starts with a notice. **Menu → Start a new game** resets.

## Tests

- `npm test`: 69 tests. `tests/catastrophes.test.ts` covers scenario initialisation; random selection; difficulty; rescue, levees and floods; radiation shelter; quarantine vs. spread; bites and treatment; noise and the horde; raid defence; fire; director prerequisites, warnings that are averted, and caps, cooldowns and rest periods across whole campaigns; sandbox validation; save v3→v4 migration; a full playthrough of every scenario with item conservation; and that the scenarios produce materially different campaigns. `tests/sim.test.ts` has the original 30+: inventory accounting and capacity, repair/dismantle/repurpose flows, material staging and refunds, construction and placement, power→pump→filter dependencies, fuel exhaustion, crops, survivor consumption and death causes, skill speed, time stepping and pausing, expeditions and location decisions, storm damage vs reinforcement, the travellers' consequences, save/load round-trip and determinism, rejection of malformed saves, and a full seven-day scripted playthrough with conservation checked every hour.
- `npm run e2e` — launches the production build in Chromium at 1440×900 and at iPhone size with touch, then: dismisses the intro, taps the forklift in the world and queues a job, selects a survivor and taps to move, places and completes a building, sends an expedition and resolves its decision, fast-forwards through night and to the end, checks the summary, reload persistence, corrupted-save recovery, no page scroll, and no runtime errors.

## Known limitations

- iPhone support is verified with Chromium's mobile emulation (touch events, 390×844 at 3×), not on a physical device or WebKit.
- Expeditions use the regional map rather than real-time outdoor exploration; the expedition/survivor model is built so a walkable outdoor map can be added later.
- Social simulation is a foundation only: morale is fully simulated (and drives desertion), but relationships are stored and have little effect yet.
- There is no tactical combat. Raids, breaches and hordes are resolved through the defence rating and your decisions.
- The scripted test player wins every scenario on Standard. Balance for human players needs playtesting, especially on Brutal.
- One scenario and one compound layout; no audio yet.
