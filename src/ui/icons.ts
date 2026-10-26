// Inline SVG icon set (stroke icons on a 24px grid), injected once as a sprite.

const PATHS: Record<string, string> = {
  scrap: '<path d="M4 17l4-9 5 3 3-6 4 4-2 9H6z"/><path d="M9 14h4"/>',
  mech: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  elec: '<rect x="5" y="7" width="14" height="10" rx="2"/><path d="M9 7V4M15 7V4M9 20v-3M15 20v-3M9 12h6"/>',
  fuel: '<path d="M6 21V6l3-3h7l2 2v16z"/><path d="M9 3l2 3h5"/><path d="M9 12h6"/>',
  battery: '<rect x="4" y="7" width="15" height="10" rx="2"/><path d="M21 10v4M8 12h3M9.5 10.5v3"/>',
  tools: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  food: '<path d="M6 8h12v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><ellipse cx="12" cy="8" rx="6" ry="2"/><path d="M6 13h12"/>',
  water: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>',
  rawWater: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/><path d="M9 15c1 1 2 1 3 0s2-1 3 0"/>',
  meds: '<rect x="4" y="6" width="16" height="13" rx="2"/><path d="M12 9.5v6M9 12.5h6M9 6V4h6v2"/>',
  engine: '<path d="M4 10h3l2-3h6v3h3v6h-3v2H9l-2-2H4z"/><path d="M1 12h3M20 13h3"/>',
  filter: '<path d="M4 4h16l-6 8v7l-4 2v-9z"/>',
  power: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  storm: '<path d="M7 16a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 18 9a3.5 3.5 0 0 1 0 7"/><path d="M12 13l-2 4h3l-2 4"/>',
  rain: '<path d="M7 15a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 18 8a3.5 3.5 0 0 1 0 7z"/><path d="M8 18l-1 2M12 18l-1 2M16 18l-1 2"/>',
  cloud: '<path d="M7 18a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 18 11a3.5 3.5 0 0 1 0 7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  ff: '<path d="M4 6l8 6-8 6zM12 6l8 6-8 6z"/>',
  fff: '<path d="M2 6l6 6-6 6zM9 6l6 6-6 6zM16 6l6 6-6 6z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  build: '<path d="M3 21l9-9M14 4l6 6-3 3-6-6z"/><path d="M11 7l-2-2 3-2 2 2"/>',
  jobs: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  log: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>',
  bed: '<path d="M3 18V8M3 14h18v4M21 18v-4a3 3 0 0 0-3-3H10v3"/><circle cx="6.5" cy="11.5" r="1.5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  stores: '<path d="M3 9l9-5 9 5v11H3z"/><path d="M8 20v-6h8v6"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  team: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c.5-4 3-6 6-6s5.5 2 6 6M15 14c3 0 5 2 5.5 5"/>',
  center: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
};

export function injectIcons(): void {
  if (document.getElementById('icon-sprite')) return;
  const symbols = Object.entries(PATHS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`)
    .join('');
  const div = document.createElement('div');
  div.innerHTML = `<svg id="icon-sprite" xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols}</svg>`;
  document.body.prepend(div.firstChild!);
}

export function icon(name: string, cls = ''): string {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${PATHS[name] ? name : 'warn'}"/></svg>`;
}
