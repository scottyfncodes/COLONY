// End-to-end browser check: drives the real UI at desktop and iPhone sizes.
// Usage: npm run build && npm run e2e   (starts `vite preview` itself)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const out = process.env.SHOTS ?? 'scripts/out';
mkdirSync(out, { recursive: true });
const port = 4180;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const url = `http://localhost:${port}`;
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
};

async function run(name, opts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('fonts.g') && errors.push(m.text()));
  await page.goto(url);
  await page.waitForTimeout(800);
  const tap = async (x, y) => (opts.hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  const tapSel = async (sel) => {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      await shot('missing');
      throw new Error(`${name}: ${sel} not visible; panel=${await ev(() => window.__colony.panel)}`);
    }
    if (opts.hasTouch) await loc.tap();
    else await loc.click();
    await page.waitForTimeout(150);
  };
  const shot = (n) => page.screenshot({ path: `${out}/${name}-${n}.png` });
  const ev = (fn, arg) => page.evaluate(fn, arg);

  check(await page.locator('.sheet.m-scenario').isVisible(), `${name}: first launch shows scenario selection`);
  await tapSel('[data-a="draft"][data-v="pick|storm"]');
  await tapSel('[data-a="begin"]');
  check(await page.locator('.sheet.m-event').isVisible(), `${name}: intro event shown`);
  await tapSel('[data-a="choose"]');
  check(!(await page.locator('#modal').isVisible()), `${name}: intro dismissed`);
  const scroll = await ev(() => [document.scrollingElement.scrollHeight, window.innerHeight]);
  check(scroll[0] <= scroll[1], `${name}: page does not scroll`);

  // Tap the forklift in the world and queue "Pull engine".
  await ev(() => window.__colony.centerOnObject('forklift'));
  const fp = await ev(() => window.__colony.screenOf(19.5, 7, 20));
  await tap(fp.x, fp.y);
  await page.waitForTimeout(250);
  const title = await page.locator('#panel h2').first().textContent().catch(() => '');
  check(/Forklift/.test(title ?? ''), `${name}: tapping the forklift opens its panel (${title})`);
  await shot('forklift-panel');
  await tapSel('[data-a="queue"][data-v="forklift|pullEngine"]');
  check(await ev(() => window.__colony.state.jobs.some((j) => j.actionId === 'pullEngine')), `${name}: pull-engine job queued from UI`);

  // Select Ines from the roster; tap the ground to move her.
  await tapSel('[data-a="sel-surv"][data-v="s-amara"]');
  check(/Amara/.test(await page.locator('#panel h2').first().textContent()), `${name}: survivor panel opens`);
  // Heaps move between games, so find a yard tile where a tap really lands on open ground.
  const gp = await ev(() => {
    const g = window.__colony;
    for (let y = 13; y < 21; y++)
      for (let x = 14; x < 22; x++) {
        g.focus(x + 0.5, y + 0.5);
        const p = g.screenOf(x + 0.5, y + 0.5);
        const hit = g.renderer.pick(g.state, p.x, p.y);
        if (hit.kind !== 'survivor' && hit.kind !== 'object') return p;
      }
    return g.screenOf(16.5, 15.5);
  });
  await tap(gp.x, gp.y);
  check(await ev(() => !!window.__colony.state.survivors.find((s) => s.id === 's-amara').moveTarget), `${name}: tap-to-move order given`);

  // Build a cot through the build menu.
  await tapSel('[data-a="close-panel"]');
  await tapSel('#dock [data-v="build"]');
  await tapSel('[data-a="bp"][data-v="cot"]');
  await ev(() => window.__colony.focus(7.5, 16.5));
  const cp = await ev(() => window.__colony.screenOf(7.5, 16.5));
  await tap(cp.x, cp.y);
  await page.waitForTimeout(150);
  await shot('placing');
  // On desktop the hover ghost means the click already confirmed; on touch, confirm explicitly.
  if (await page.locator('[data-a="place-confirm"]').isVisible()) await tapSel('[data-a="place-confirm"]');
  check(await ev(() => window.__colony.state.objects.some((o) => o.state === 'site' && o.type === 'cot')), `${name}: construction site placed`);

  // Run time forward and watch jobs complete.
  await ev(() => window.__colony.advance(240));
  await page.waitForTimeout(400);
  await shot('working');
  check(await ev(() => (window.__colony.state.inventory.engine ?? 0) >= 1 || window.__colony.state.jobs.some((j) => j.actionId === 'pullEngine' && j.phase === 'haul')), `${name}: engine pulled by a worker`);
  check(await ev(() => window.__colony.state.objects.some((o) => o.type === 'cot' && o.state === 'operational' && o.id.startsWith('o-cot-'))), `${name}: cot built`);

  // Expedition.
  await tapSel('#dock [data-a="expedition"]');
  await tapSel('[data-a="exp-dest"][data-v="market"]');
  await tapSel('[data-a="exp-member"][data-v="s-june"]');
  await tapSel('[data-a="exp-member"][data-v="s-sol"]');
  await shot('expedition');
  await tapSel('[data-a="exp-send"]');
  check(await ev(() => window.__colony.state.survivors.find((s) => s.id === 's-june').away), `${name}: expedition sent`);
  await tapSel('[data-a="modal-close"]');

  // Fast-forward through the decision at the market.
  for (let i = 0; i < 20; i++) {
    await ev(() => window.__colony.advance(120));
    if (await page.locator('.sheet.m-event').isVisible()) {
      await shot('decision');
      await tapSel('[data-a="choose"]:not([disabled])');
    }
    if (await ev(() => !window.__colony.state.survivors.find((s) => s.id === 's-june').away)) break;
  }
  check(await ev(() => window.__colony.state.locations.market.visits === 1), `${name}: expedition returned with outcome`);

  // Fast-forward helper running inside the page: resolves decisions with the first available choice.
  const ff = (until) =>
    ev((src) => {
      const g = window.__colony;
      const done = new Function('s', `return ${src}`);
      for (let i = 0; i < 20000 && !done(g.state); i++) {
        if (g.state.result) break;
        if (g.state.events.pending) g.command({ type: 'choose', choiceId: g.state.events.pending.choices.find((c) => c.available).id });
        else g.advance(1);
      }
      return { minute: g.state.minute, alive: g.state.survivors.filter((x) => x.alive).length };
    }, until);
  // Night shot.
  await ff('s.minute % 1440 === 23 * 60');
  await page.waitForTimeout(400);
  await shot('night');
  // Storm shot.
  await ff('s.weather.kind === "storm" && s.minute > s.weather.stormStart + 90');
  await page.waitForTimeout(500);
  await shot('storm');
  // End of scenario.
  const endInfo = await ff('!!s.result');
  console.log(`  ${name}: reached minute ${endInfo.minute}, ${endInfo.alive} alive`);
  await page.waitForTimeout(500);
  check(await page.locator('.end').isVisible(), `${name}: end-of-scenario summary shown`);
  await shot('end');
  // Reload keeps progress.
  await ev(() => window.__colony.save());
  const minute = await ev(() => window.__colony.state.minute);
  await page.reload();
  await page.waitForTimeout(800);
  check((await ev(() => window.__colony.state.minute)) === minute, `${name}: progress restored after reload`);
  // Corrupt save handled.
  await ev(() => {
    window.__colony.save = () => {};
    localStorage.setItem('colony.save', '{broken');
  });
  await page.reload();
  await page.waitForTimeout(800);
  check(await ev(() => window.__colony.state.minute === 420), `${name}: corrupted save falls back to a new game`);
  // Phase 2: choose a catastrophe from the menu.
  if (await page.locator('.sheet.m-scenario').isVisible()) await tapSel('[data-a="modal-close"]');
  if (await page.locator('.sheet.m-event').isVisible()) await tapSel('[data-a="choose"]');
  await tapSel('#speed [data-a="modal"][data-v="menu"]');
  await tapSel('[data-a="modal"][data-v="scenario"]');
  await tapSel('[data-a="draft"][data-v="pick|pandemic"]');
  await tapSel('[data-a="begin"]');
  check((await page.locator('.ev-title').textContent()).includes('The Fever'), `${name}: pandemic briefing shown`);
  await tapSel('[data-a="choose"]');
  check(await ev(() => window.__colony.state.world.catastrophe === 'pandemic' && window.__colony.state.survivors.some((x) => x.illness)), `${name}: pandemic initialised (someone incubating)`);
  await tapSel('#dock [data-v="world"]');
  check(/The Fever/.test(await page.locator('#panel h2').first().textContent()), `${name}: World panel shows the scenario`);
  await shot('world-pandemic');
  await tapSel('[data-a="sel-surv"][data-v="s-theo"]');
  await tapSel('[data-a="quarantine"][data-v="s-theo"]');
  check(await ev(() => window.__colony.state.survivors.find((x) => x.id === 's-theo').quarantined), `${name}: quarantine from the survivor panel`);
  // Custom sandbox: fallout with the infected layered on top.
  await tapSel('[data-a="close-panel"]');
  await tapSel('#speed [data-a="modal"][data-v="menu"]');
  await tapSel('[data-a="modal"][data-v="scenario"]');
  await tapSel('[data-a="draft"][data-v="view|custom"]');
  await tapSel('[data-a="draft"][data-v="main|fallout"]');
  await tapSel('[data-a="draft"][data-v="extra|outbreak"]');
  await shot('sandbox-setup');
  await tapSel('[data-a="begin"]');
  await tapSel('[data-a="choose"]');
  check(await ev(() => { const w = window.__colony.state.world; return w.mode === 'sandbox' && w.catastrophe === 'fallout' && w.extra.includes('outbreak'); }), `${name}: sandbox with layered catastrophes`);
  await tapSel('#dock [data-v="world"]');
  await tapSel('[data-a="sb-add"][data-v="quake"]');
  check(await ev(() => window.__colony.state.world.extra.includes('quake') && window.__colony.state.objects.some((o) => o.type === 'rubble')), `${name}: sandbox adds an earthquake mid-game`);
  await tapSel('[data-a="sb-weather"][data-v="squall"]');
  await tapSel('[data-a="sb-cond"][data-v="horde|10"]');
  check(await ev(() => window.__colony.state.world.horde >= 24), `${name}: sandbox adjusts conditions`);
  await ev(() => window.__colony.advance(90));
  await page.waitForTimeout(600);
  await shot('sandbox-play');
  const sv = await ev(() => { localStorage.setItem('probe', '1'); return window.__colony.save(), JSON.parse(localStorage.getItem('colony.save')).world.extra.length; });
  check(sv === 2, `${name}: sandbox state saves cleanly`);
  check(errors.length === 0, `${name}: no runtime errors ${errors.join(' | ')}`);
  await browser.close();
}

try {
  await run('desktop', { viewport: { width: 1440, height: 900 } });
  await run('iphone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
