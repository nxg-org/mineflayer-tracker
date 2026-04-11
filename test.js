
const fs = require('fs');
const lines = fs.readFileSync('output.log', 'utf8').split(/\r?\n/);
let state = '[no chat yet]';
const groups = new Map();
const chat = /\[chat:tick=(\d+)\] (.*)$/;
const shot = /\[shot-planner:startTick=(\d+)\].*?confidence=([0-9.]+).*?actualRelativeDelta=move=\(([-0-9.]+),\s*([-0-9.]+)\)/;
for (const line of lines) {
  const cm = line.match(chat);
  if (cm) {
    state = `tick ${cm[1]} | ${cm[2]}`;
    if (!groups.has(state)) groups.set(state, []);
    continue;
  }
  const sm = line.match(shot);
  if (sm) {
    if (!groups.has(state)) groups.set(state, []);
    const tick = Number(sm[1]);
    const conf = Number(sm[2]);
    const dx = Number(sm[3]);
    const dz = Number(sm[4]);
    const speed = Math.hypot(dx, dz);
    groups.get(state).push({ tick, conf, speed });
  }
}
for (const [state, items] of groups) {
  if (items.length < 4) continue;
  const confs = items.map(x => x.conf);
  const speeds = items.map(x => x.speed);
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = arr => Math.min(...arr);
  const max = arr => Math.max(...arr);
  console.log('STATE', state);
  console.log(' count=', items.length, 'conf_avg=', avg(confs).toFixed(4), 'conf_min=', min(confs).toFixed(4), 'conf_max=', max(confs).toFixed(4), 'speed_avg=', avg(speeds).toFixed(4));
  console.log(' first=', items[0].tick, items[0].conf.toFixed(4), items[0].speed.toFixed(4));
  console.log(' last =', items[items.length - 1].tick, items[items.length - 1].conf.toFixed(4), items[items.length - 1].speed.toFixed(4));
  console.log('""');
}