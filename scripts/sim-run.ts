import { newGame } from '../src/sim/sim';
import { playBot } from '../tests/bot';
import { dayOf, clockString } from '../src/sim/time';
import type { CatastropheId } from '../src/sim/types';
const cat = (process.argv[2] ?? 'storm') as CatastropheId;
const s = newGame(Number(process.argv[3] ?? 42), { catastrophe: cat });
const verbose = process.argv[4] === 'v';
let lastLog = 0;
for (let h = 0; h < 7 * 24 + 2 && !s.result; h++) {
  playBot(s, 60);
  for (; lastLog < s.log.length; lastLog++) {
    const e = s.log[lastLog];
    if (verbose || e.tone !== 'info') console.log(`D${dayOf(e.t)} ${clockString(e.t)} [${e.tone}] ${e.text}`);
  }
}
console.log(cat, s.result?.status, s.result?.grade, '|', s.result?.lines.slice(0, 3).join(' | '));
console.log('objectives', s.result?.objectives.map((o) => `${o.label}:${o.done ? 'Y' : 'n'}`).join(', '));
console.log('world', JSON.stringify({ ...s.world, director: { counts: s.world.director.counts } }).slice(0, 400));
