import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDoorPeriods, summarizeDoorPeriods, doorTimeline, doorTime, newestHistoryFirst, doorStateRows } from "../src/doorActivity.js";

const base = Date.parse("2026-10-16T12:00:00Z");
const at = seconds => new Date(base + seconds * 1000).toISOString();
const event = (id, from, to, extra = {}) => ({ _id: id, openedAt: at(from), closedAt: to === null ? null : at(to), status: to === null ? "OPEN" : "CLOSED", ...extra });

test("counts 32 completed backend records as 32 openings, not zero", () => {
  const records = Array.from({ length: 32 }, (_, index) => event(String(index), index * 60, index * 60 + 10, { durationSeconds: 0 }));
  const stats = summarizeDoorPeriods(normalizeDoorPeriods(records), records.length);
  assert.equal(stats.openings, 32);
  assert.equal(stats.completedPeriods, 32);
  assert.equal(stats.totalSeconds, 320);
  assert.equal(stats.longestSeconds, 10);
});

test("includes an unclosed opening in the count, but excludes it from completed durations", () => {
  const stats = summarizeDoorPeriods(normalizeDoorPeriods([event("closed", 0, 20), event("open", 60, null)]));
  assert.equal(stats.openings, 2);
  assert.equal(stats.totalSeconds, 20);
  assert.equal(stats.unmatchedOpen, true);
});

test("excludes uncertain, invalid and reversed durations without hiding the opening count", () => {
  const stats = summarizeDoorPeriods(normalizeDoorPeriods([
    event("gap", 0, 30, { durationUncertain: true }),
    event("reverse", 50, 20), event("bad-date", 0, 10, { openedAt: "bad" }),
    event("missing-close", 10, null, { status: "CLOSED" }),
  ]));
  assert.equal(stats.openings, 4);
  assert.equal(stats.completedPeriods, 0);
  assert.equal(stats.totalSeconds, null);
  assert.equal(stats.uncertainPeriods, 4);
});

test("deduplicates repeated records and accepts a real zero-second opening", () => {
  const row = event("same", 0, 0);
  assert.equal(normalizeDoorPeriods([row, row]).length, 1);
  assert.equal(summarizeDoorPeriods(normalizeDoorPeriods([row])).totalSeconds, 0);
});

test("pairs legacy transitions per device in timestamp order, without counting repeated OPEN states", () => {
  const records = [
    { deviceId: "one", type: "CLOSED", timestamp: at(10) },
    { deviceId: "one", type: "OPEN", timestamp: at(0) },
    { deviceId: "one", type: "OPEN", timestamp: at(3) },
    { deviceId: "two", type: "OPEN", timestamp: at(2) },
    { deviceId: "two", type: "CLOSED", timestamp: at(22) },
  ];
  const stats = summarizeDoorPeriods(normalizeDoorPeriods(records));
  assert.equal(stats.openings, 2);
  assert.equal(stats.totalSeconds, 30);
});

test("clips chart bars to the selected sensor-history window", () => {
  const periods = normalizeDoorPeriods([event("before", -60, -10), event("cross", -5, 15), event("after", 60, 90)]);
  const bars = doorTimeline(periods, base, base + 10000);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].from, base);
  assert.equal(bars[0].to, base + 10000);
  assert.equal(bars[0].durationSeconds, 20); // detail retains the full recorded period
});

test("never extends an unclosed record to now without a supporting sensor observation", () => {
  const periods = normalizeDoorPeriods([event("open", 0, null)]);
  const bars = doorTimeline(periods, base, base + 120000);
  assert.equal(bars[0].to, base);
  assert.equal(bars[0].confirmedThrough, null);
  const observed = doorTimeline(periods, base, base + 120000, base + 20000);
  assert.equal(observed[0].to, base + 20000);
  assert.equal(observed[0].completed, false);
});

test("guards empty input/windows and formats the fixed IST timezone", () => {
  assert.deepEqual(normalizeDoorPeriods(null), []);
  assert.equal(summarizeDoorPeriods([]).openings, 0);
  assert.equal(summarizeDoorPeriods([]).totalSeconds, 0);
  assert.deepEqual(doorTimeline([], null, null), []);
  assert.match(doorTime(base), /17:30:00/);
});

test("shows the newest table readings first without reversing chart input", () => {
  const rows = [{ time: base }, { time: base + 10000 }, { time: null }, { time: base + 5000 }];
  const sorted = newestHistoryFirst(rows);
  assert.deepEqual(sorted.map(row => row.time), [base + 10000, base + 5000, base, null]);
  assert.equal(rows[0].time, base);
});

test("step chart follows actual sample states and attaches recorded opening details", () => {
  const periods = normalizeDoorPeriods([event("sampled", 5, 15)]);
  const rows = [false, true, true, false].map((doorOpen, index) => ({ time: base + index * 5000, capturedAt: at(index * 5), doorOpen }));
  const points = doorStateRows([...rows].reverse(), periods);
  assert.deepEqual(points.map(point => point.doorState), [0, 1, 1, 0]);
  assert.equal(points[2].observedSeconds, 5);
  assert.equal(points[1].opening.durationSeconds, 10);
  assert.equal(rows[0].doorOpen, false);
});

test("long gaps break the step line and reset observed-open duration", () => {
  const points = doorStateRows([
    { time: base, capturedAt: at(0), doorOpen: true },
    { time: base + 60000, capturedAt: at(60), doorOpen: true },
  ]);
  assert.equal(points.length, 3);
  assert.equal(points[1].doorState, null);
  assert.equal(points[2].observedSeconds, 0);
});

test("unknown capture time and unknown door state never become a false closed state", () => {
  const points = doorStateRows([
    { time: base, capturedAt: null, timeQuality: "unknown", doorOpen: false },
    { time: base + 5000, capturedAt: at(5), doorOpen: null },
  ]);
  assert.deepEqual(points.map(point => point.doorState), [null, null]);
});
