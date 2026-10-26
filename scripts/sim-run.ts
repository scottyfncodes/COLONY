import { createGame } from '../src/sim/setup';
import { runEvents } from '../src/sim/events';
import { playBot } from '../tests/bot';
import { dayOf, clockString } from '../src/sim/time';
const s = createGame(Number(process.argv[2] ?? 42));
runEvents(s);
let lastLog = 0;
for (let h = 0; h < 7 * 24; h++) {
  playBot(s, 60);
  for (; lastLog < s.log.length; lastLog++) {
    const e = s.log[lastLog];
    console.log(`D${dayOf(e.t)} ${clockString(e.t)} [${e.tone}] ${e.text}`);
  }
  if (h % 12 === 0) {
    const inv = Object.entries(s.inventory).map(([k, v]) => `${k}:${(v as number).toFixed(1)}`).join(' ');
    console.log(`   == D${dayOf(s.minute)} ${clockString(s.minute)} inv ${inv} | jobs ${s.jobs.length} | ${s.survivors.map((x) => `${x.name.split(' ')[0]}:${x.activity}:h${x.health.toFixed(0)}t${x.thirst.toFixed(0)}f${x.hunger.toFixed(0)}e${x.energy.toFixed(0)}`).join(' ')}`);
    console.log(`   == jobs: ${s.jobs.map((j) => `${j.label}[${j.phase}${j.assigneeId ? ':' + j.assigneeId.slice(2) : ''}${j.blockedReason ? ' ' + j.blockedReason : ''}]`).join(', ')}`);
  }
  if (s.result) break;
}
console.log(JSON.stringify(s.result, null, 1));
