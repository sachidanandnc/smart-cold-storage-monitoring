export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function describeNumbers(rows, key) {
  const values = rows.map(row => finiteNumber(row[key])).filter(value => value !== null);
  if (!values.length) return { count: 0, min: null, average: null, max: null };
  return {
    count: values.length,
    min: Math.min(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  };
}

export function summarizeHistory(rows) {
  const readings = Array.isArray(rows) ? rows : [];
  const distribution = Object.fromEntries([...RISK_LEVELS, "UNKNOWN"].map(level => [level, 0]));
  const validTimes = readings.map(row => row.time).filter(Number.isFinite);
  for (const row of readings) {
    const level = typeof row.riskLevel === "string" ? row.riskLevel.trim().toUpperCase() : "";
    distribution[RISK_LEVELS.includes(level) ? level : "UNKNOWN"] += 1;
  }
  return {
    count: readings.length,
    first: validTimes.length ? Math.min(...validTimes) : null,
    last: validTimes.length ? Math.max(...validTimes) : null,
    temperature: describeNumbers(readings, "temperature"),
    humidity: describeNumbers(readings, "humidity"),
    risk: describeNumbers(readings, "riskScore"),
    distribution,
  };
}

export function extractDoorEvents(payload) {
  const events = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.events) ? payload.events
    : Array.isArray(payload?.doorEvents) ? payload.doorEvents
    : Array.isArray(payload?.data?.events) ? payload.data.events
    : null;
  if (!events) throw new Error("Invalid door-events response");
  return events.filter(event => event && typeof event === "object");
}

function eventState(event) {
  if (typeof event.doorOpen === "boolean") return event.doorOpen ? "OPEN" : "CLOSED";
  if (event.doorOpen === 1 || event.doorOpen === "true") return "OPEN";
  if (event.doorOpen === 0 || event.doorOpen === "false") return "CLOSED";
  const raw = event.eventType ?? event.type ?? event.action ??
    event.status ?? event.doorStatus ?? event.state ?? event.event;
  if (typeof raw !== "string") {
    return event.openedAt && event.closedAt ? "PERIOD" : null;
  }
  const normalized = raw.trim().toUpperCase().replaceAll(/[^A-Z]/g, "");
  if (normalized === "OPEN" || normalized === "OPENED" || normalized === "DOOROPEN" || normalized === "DOOROPENED") return "OPEN";
  if (normalized === "CLOSE" || normalized === "CLOSED" || normalized === "DOORCLOSE" || normalized === "DOORCLOSED") return "CLOSED";
  return null;
}

function reportedDurationSeconds(event) {
  const explicitSeconds = finiteNumber(event.durationSeconds ?? event.openDurationSeconds ??
    event.duration ?? event.openDuration);
  if (explicitSeconds !== null) return explicitSeconds >= 0 ? explicitSeconds : null;
  const milliseconds = finiteNumber(event.durationMs ?? event.openDurationMs);
  return milliseconds !== null && milliseconds >= 0 ? milliseconds / 1000 : null;
}

export function summarizeDoorEvents(payload) {
  const events = extractDoorEvents(payload);
  const normalized = events.map(event => ({
    state: eventState(event),
    time: timestamp(event.timestamp ?? event.eventTime ?? event.occurredAt ??
      event.createdAt ?? event.time ?? event.openedAt),
    duration: reportedDurationSeconds(event),
    openedAt: timestamp(event.openedAt),
    closedAt: timestamp(event.closedAt),
  })).sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  let openings = 0;
  let pendingOpen = null;
  let openUnclosed = false;
  const completedDurations = [];
  for (const event of normalized) {
    if (event.state === "OPEN") {
      openings += 1;
      pendingOpen = event.time;
      openUnclosed = true;
    } else if (event.state === "CLOSED") {
      const paired = pendingOpen !== null && event.time !== null && event.time >= pendingOpen
        ? (event.time - pendingOpen) / 1000 : null;
      const duration = event.duration ?? paired;
      if (duration !== null) completedDurations.push(duration);
      pendingOpen = null;
      openUnclosed = false;
    } else if (event.state === "PERIOD") {
      openings += 1;
      const paired = event.openedAt !== null && event.closedAt !== null &&
        event.closedAt >= event.openedAt
        ? (event.closedAt - event.openedAt) / 1000 : null;
      const duration = event.duration ?? paired;
      if (duration !== null) completedDurations.push(duration);
    }
  }
  return {
    eventCount: events.length,
    openings,
    completedPeriods: completedDurations.length,
    totalSeconds: completedDurations.length
      ? completedDurations.reduce((sum, seconds) => sum + seconds, 0) : null,
    longestSeconds: completedDurations.length ? Math.max(...completedDurations) : null,
    unmatchedOpen: openUnclosed,
  };
}
