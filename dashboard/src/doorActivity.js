// Door events are opening periods in the current API. Older APIs may return
// separate OPEN/CLOSED transitions; normalize both into the same shape.
function time(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function state(event) {
  if ([true, 1, "true"].includes(event.doorOpen)) return "OPEN";
  if ([false, 0, "false"].includes(event.doorOpen)) return "CLOSED";
  const raw = event.eventType ?? event.type ?? event.action ?? event.status ?? event.doorStatus ?? event.state ?? event.event;
  const name = typeof raw === "string" ? raw.trim().toUpperCase().replace(/[^A-Z]/g, "").replace(/^DOOR/, "") : "";
  if (name === "OPEN" || name === "OPENED") return "OPEN";
  if (name === "CLOSE" || name === "CLOSED") return "CLOSED";
  return null;
}

function period(event, openedAt, closedAt, completed, key) {
  const invalidRange = openedAt === null || (completed && (closedAt === null || closedAt < openedAt));
  const uncertain = event.durationUncertain === true || invalidRange;
  return {
    key, openedAt, closedAt, completed, uncertain,
    // Actual endpoints take precedence over a missing/default stored duration.
    durationSeconds: !completed || uncertain ? null
      : (closedAt - openedAt) / 1000,
  };
}

export function normalizeDoorPeriods(events) {
  const result = [];
  const transitions = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const openedAt = time(event.openedAt);
    const closedAt = time(event.closedAt);
    const eventTime = time(event.timestamp ?? event.eventTime ?? event.occurredAt ?? event.createdAt ?? event.time);
    const device = event.deviceId || "default";
    const type = state(event);
    const key = String(event._id ?? event.id ?? `${device}:${event.openedAt ?? eventTime}:${event.closedAt ?? type}`);
    if (seen.has(key)) continue;
    seen.add(key);
    if (event.openedAt != null && event.openedAt !== "") {
      // CLOSED describes the final state of this opening, not a separate close.
      const completed = closedAt !== null || type === "CLOSED";
      result.push(period(event, openedAt, closedAt, completed, key));
    } else if (type === "OPEN" || type === "CLOSED") {
      transitions.push({ event, type, eventTime, device, key });
    }
  }
  const pending = new Map();
  transitions.sort((a, b) => (a.eventTime ?? Infinity) - (b.eventTime ?? Infinity));
  for (const item of transitions) {
    if (item.type === "OPEN") {
      // Repeated OPEN observations do not create extra physical openings.
      if (!pending.has(item.device)) pending.set(item.device, item);
    } else if (pending.has(item.device)) {
      const opening = pending.get(item.device);
      result.push(period({ ...item.event, durationUncertain: opening.event.durationUncertain === true || item.event.durationUncertain === true }, opening.eventTime, item.eventTime, true, opening.key));
      pending.delete(item.device);
    }
  }
  for (const opening of pending.values()) result.push(period(opening.event, opening.eventTime, null, false, opening.key));
  return result.sort((a, b) => (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity));
}

export function summarizeDoorPeriods(periods, eventCount = periods.length) {
  const durations = periods.filter(item => item.completed && !item.uncertain && item.durationSeconds !== null).map(item => item.durationSeconds);
  return {
    eventCount, openings: periods.length, completedPeriods: durations.length,
    totalSeconds: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : periods.length ? null : 0,
    longestSeconds: durations.length ? Math.max(...durations) : null,
    unmatchedOpen: periods.some(item => !item.completed),
    uncertainPeriods: periods.filter(item => item.uncertain).length,
  };
}

export function doorTimeline(periods, start, end, observedOpenAt = null) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  return periods.flatMap(item => {
    if (item.openedAt === null) return [];
    // An unclosed database record alone is not evidence the door is open now.
    const until = item.completed ? item.closedAt
      : observedOpenAt !== null && observedOpenAt >= item.openedAt ? observedOpenAt : item.openedAt;
    if (until === null || until < item.openedAt || until < start || item.openedAt > end) return [];
    return [{
      ...item, from: Math.max(start, item.openedAt), to: Math.min(end, until),
      confirmedThrough: !item.completed && until > item.openedAt ? until : null,
    }];
  });
}

export function doorDuration(value) {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  const total = Math.round(value);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m`;
}

export function doorTime(value, full = false) {
  if (!Number.isFinite(value)) return "Unknown";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", ...(full ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(value);
}

export function newestHistoryFirst(rows) {
  const rowTime = row => Number.isFinite(row.time) ? row.time : time(row.timestamp) ?? time(row.receivedAt) ?? -Infinity;
  return [...rows].sort((a, b) => rowTime(b) - rowTime(a));
}

export function doorStateRows(rows, periods = [], maxGapMs = 15000) {
  const samples = [...rows].filter(row => Number.isFinite(row.time)).sort((a, b) => a.time - b.time);
  const points = [];
  let previous = null;
  let observedStart = null;
  for (const row of samples) {
    const captureKnown = row.capturedAt != null ? time(row.capturedAt) !== null
      : row.capturedAt === undefined && row.timeQuality !== "unknown";
    const doorState = !captureKnown ? null : row.doorOpen === true ? 1 : row.doorOpen === false ? 0 : null;
    const gap = previous && row.time - previous.time > maxGapMs;
    // A long gap or an unknown capture time cannot establish a continuous state.
    if (gap) points.push({ time: previous.time + 1, doorState: null });
    if (doorState !== 1) observedStart = null;
    else if (!previous || previous.doorState !== 1 || gap) observedStart = row.time;
    const opening = doorState === 1 ? [...periods].reverse().find(item => item.openedAt !== null && item.openedAt <= row.time &&
      (!item.completed || (item.closedAt !== null && item.closedAt >= row.time))) : null;
    const point = { time: row.time, doorState, opening: opening ?? null, observedSeconds: doorState === 1 ? (row.time - observedStart) / 1000 : null };
    points.push(point);
    previous = point;
  }
  return points;
}
