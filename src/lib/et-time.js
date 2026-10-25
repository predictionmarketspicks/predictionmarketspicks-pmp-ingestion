// Eastern-time helpers (DST-aware via Intl). Pure; `now` is injectable.

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(d) {
  const o = {};
  for (const p of FMT.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

// ms to ADD to a UTC instant to get ET wall-clock (negative: −4h EDT / −5h EST).
function etOffsetMs(d) {
  const p = parts(d);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60_000) * 60_000;
}

// UTC instant of an ET wall-clock time. Re-checks the offset at the result so a
// DST-change day lands on the right hour.
export function etWallToUtc(year, month, day, hour = 0, minute = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = wall - etOffsetMs(new Date(wall));
  t = wall - etOffsetMs(new Date(t));
  return new Date(t);
}

// 'YYYY-MM-DD' of the ET calendar day.
export function etDateKey(now = new Date()) {
  const p = parts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// UTC instant of 00:00 ET on the ET day containing `now`.
export function etDayStart(now = new Date()) {
  const p = parts(now);
  return etWallToUtc(p.year, p.month, p.day, 0, 0);
}

// Next instant strictly after `now` that falls on one of the ET hours in `hours`.
export function nextEtSlot(hours, now = new Date()) {
  const p = parts(now);
  const sorted = [...hours].sort((a, b) => a - b);
  for (let add = 0; add < 3; add++) {
    for (const h of sorted) {
      const t = etWallToUtc(p.year, p.month, p.day + add, h, 0);
      if (t.getTime() > now.getTime()) return t;
    }
  }
  return null;
}
