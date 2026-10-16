import { normalizeDoorPeriods, summarizeDoorPeriods } from "./doorActivity";

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

export function summarizeDoorEvents(payload) {
  const events = extractDoorEvents(payload);
  return summarizeDoorPeriods(normalizeDoorPeriods(events), events.length);
}
