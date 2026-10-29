// Balance sweep: plays many seeded campaigns per scenario and difficulty with the scripted
// player and reports how often the settlement survives. Usage:
//   npx vite-node scripts/balance.ts [runs=20] [every=30] [difficulty]
// `every` is how often (game minutes) the bot makes decisions: 30 ≈ attentive expert, 240 ≈ casual.
import { newGame } from '../src/sim/sim';
import { CATASTROPHE_IDS } from '../src/sim/catastrophes';
import { playBot } from '../tests/bot';
import type { Difficulty } from '../src/sim/types';

const runs = Number(process.argv[2] ?? 20);
const every = Number(process.argv[3] ?? 30);
const diffs: Difficulty[] = process.argv[4] ? [process.argv[4] as Difficulty] : ['easy', 'normal', 'hard'];
const rows: string[] = [];
for (const cat of process.argv[5] ? [process.argv[5] as typeof CATASTROPHE_IDS[number]] : CATASTROPHE_IDS) {
  for (const difficulty of diffs) {
    let won = 0;
    let alive = 0;
    let deaths = 0;
    const grades: Record<string, number> = {};
    for (let i = 0; i < runs; i++) {
      const s = newGame(1000 + i * 37, { catastrophe: cat, difficulty });
      for (let h = 0; h < 7 * 24 + 2 && !s.result; h++) playBot(s, 60, every);
      const r = s.result!;
      if (r.status === 'won') won++;
      alive += s.survivors.filter((x) => x.alive).length;
      deaths += s.stats.deaths.length;
      grades[r.grade] = (grades[r.grade] ?? 0) + 1;
    }
    const g = Object.entries(grades).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    rows.push(`${cat.padEnd(9)} ${difficulty.padEnd(7)} survive ${String(Math.round((won / runs) * 100)).padStart(3)}%  deaths/run ${(deaths / runs).toFixed(1)}  alive ${(alive / runs).toFixed(1)}  | ${g}`);
    console.log(rows[rows.length - 1]);
  }
}
