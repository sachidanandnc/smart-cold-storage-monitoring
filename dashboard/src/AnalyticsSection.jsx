import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractDoorEvents, RISK_LEVELS, summarizeDoorEvents, summarizeHistory,
} from "./analytics";
import "./AnalyticsSection.css";
import { API_BASE, readHeaders } from "./api";

const DOOR_EVENTS_URL = API_BASE + "/api/door-events";
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

function useDoorEvents(readKey) {
  const [state, setState] = useState({
    data: null, error: "", pending: true, lastUpdated: null,
  });
  const retryRef = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller = null;
    let timeout = null;
    async function load() {
      if (disposed || busy) return;
      busy = true;
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      setState(previous => ({ ...previous, pending: true }));
      try {
        const response = await fetch(DOOR_EVENTS_URL, {
          signal: controller.signal, cache: "no-store", headers: readHeaders(readKey),
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const payload = await response.json();
        if (payload?.success === false) throw new Error("Door events unavailable");
        const data = extractDoorEvents(payload);
        if (!disposed) setState({
          data, error: "", pending: false, lastUpdated: Date.now(),
        });
      } catch {
        if (!disposed) setState(previous => ({
          ...previous,
          error: "Door activity could not be refreshed.",
          pending: false,
        }));
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    }
    retryRef.current = load;
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [readKey]);
  const retry = useCallback(() => retryRef.current(), []);
  return { ...state, retry };
}

function value(number, digits = 1) {
  return number === null || !Number.isFinite(number) ? "—"
    : number.toLocaleString(undefined, {
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      });
}

function duration(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const rounded = Math.round(seconds);
  if (rounded < 60) return rounded + "s";
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return minutes + "m " + (rounded % 60) + "s";
  const hours = Math.floor(minutes / 60);
  return hours + "h " + (minutes % 60) + "m";
}

function NumericCard({ title, icon, stats, unit, helper }) {
  return <article className="analytics-card">
    <div className="analytics-card-head">
      <span className="analytics-card-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
    </div>
    <p className="analytics-primary"><strong>{value(stats.average)}</strong><span>{unit}</span></p>
    <p className="analytics-primary-label">Average · {stats.count} valid readings</p>
    <div className="analytics-range">
      <span>Minimum <strong>{value(stats.min)}{unit}</strong></span>
      <span>Maximum <strong>{value(stats.max)}{unit}</strong></span>
    </div>
    <p className="analytics-card-note">{helper}</p>
  </article>;
}

function DateRange({ first, last }) {
  if (first === null || last === null) return <span>No timestamped readings yet</span>;
  const options = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return <span>{new Date(first).toLocaleString(undefined, options)} – {new Date(last).toLocaleString(undefined, options)}</span>;
}

export default function AnalyticsSection({
  historyData = [], historyLimit = 50, historyPending = false, historyError = "", readKey = "",
}) {
  const stats = useMemo(() => summarizeHistory(Array.isArray(historyData) ? historyData : []), [historyData]);
  const events = useDoorEvents(readKey);
  const door = useMemo(() => events.data === null ? null : summarizeDoorEvents(events.data), [events.data]);
  const riskColors = {
    LOW: "var(--analytics-low)",
    MEDIUM: "var(--analytics-medium)",
    HIGH: "var(--analytics-high)",
    CRITICAL: "var(--analytics-critical)",
    UNKNOWN: "var(--analytics-unknown)",
  };
  const knownRiskCount = RISK_LEVELS.reduce((sum, level) => sum + stats.distribution[level], 0);
  const elevatedReadings = stats.distribution.HIGH + stats.distribution.CRITICAL;

  return <section className="analytics-section" id="analytics" aria-labelledby="analytics-title">
    <div className="section-header">
      <div>
        <p className="eyebrow">INSIGHTS FROM YOUR READINGS</p>
        <h2 id="analytics-title">Storage analytics</h2>
        <p>Patterns across the selected sensor history and recent door events.</p>
      </div>
      <div className="analytics-window" aria-label="Analytics history window">
        <strong>Last {historyLimit} readings</strong>
        <DateRange first={stats.first} last={stats.last} />
      </div>
    </div>

    {historyError && <p className="analytics-notice" role="status">
      History could not be refreshed. Analytics use the last successful readings, if available.
    </p>}
    {!stats.count && <p className="analytics-notice" role="status">
      {historyPending && !historyError
        ? "Loading sensor history for analytics…"
        : historyError
          ? "No sensor history is available for analytics yet."
          : "No timestamped sensor readings are available in this window yet."}
    </p>}

    <div className="analytics-summary-grid">
      <NumericCard title="Temperature" icon="°C" stats={stats.temperature} unit="°C"
        helper="Based on valid temperature readings." />
      <NumericCard title="Humidity" icon="%" stats={stats.humidity} unit="%"
        helper="Based on valid humidity readings." />
      <NumericCard title="Risk score" icon="/100" stats={stats.risk} unit="/100"
        helper="Calculated risk values returned by the backend." />
    </div>

    <div className="analytics-detail-grid">
      <article className="analytics-detail-card" aria-labelledby="risk-distribution-title">
        <div className="analytics-detail-head">
          <div>
            <p className="analytics-kicker">RISK MIX</p>
            <h3 id="risk-distribution-title">Risk distribution</h3>
          </div>
          <span className="analytics-count">{stats.count} readings</span>
        </div>
        <p className="analytics-detail-copy">
          How the backend classified readings in this window. {elevatedReadings} high or critical.
        </p>
        <div className="analytics-stacked-bar" role="img"
          aria-label={RISK_LEVELS.map(level => level + ": " + stats.distribution[level]).join(", ") +
            ", unclassified: " + stats.distribution.UNKNOWN}>
          {stats.count ? [...RISK_LEVELS, "UNKNOWN"].map(level => stats.distribution[level] > 0 &&
            <span key={level} style={{
              width: (stats.distribution[level] / stats.count * 100) + "%",
              background: riskColors[level],
            }} />) : <span className="analytics-stacked-empty" />}
        </div>
        <ul className="analytics-legend">
          {[...RISK_LEVELS, "UNKNOWN"].map(level =>
            <li key={level}>
              <span className="analytics-legend-dot" style={{ background: riskColors[level] }} aria-hidden="true" />
              <span>{level === "UNKNOWN" ? "Unclassified" : level.toLowerCase()}</span>
              <strong>{stats.distribution[level]}</strong>
            </li>)}
        </ul>
        {stats.count > knownRiskCount && <p className="analytics-detail-note">
          {stats.count - knownRiskCount} reading(s) have no recognized risk level.
        </p>}
      </article>

      <article className="analytics-detail-card" aria-labelledby="door-analytics-title">
        <div className="analytics-detail-head">
          <div>
            <p className="analytics-kicker">DOOR ACTIVITY</p>
            <h3 id="door-analytics-title">Opening events</h3>
          </div>
          <span className="analytics-count">{door ? door.eventCount : "—"} events</span>
        </div>
        {events.error && <div className="analytics-door-error">
          <span role="status">{events.data ? "Showing the last successful event response." : events.error}</span>
          <button type="button" onClick={events.retry} disabled={events.pending}>
            {events.pending ? "Retrying…" : "Retry"}
          </button>
        </div>}
        {!door && !events.error && <p className="analytics-detail-copy" role="status">
          Loading door events…
        </p>}
        <div className="analytics-door-grid">
          <div><span>Observed openings</span><strong>{door ? door.openings : "—"}</strong></div>
          <div><span>Total completed open time</span><strong>{duration(door?.totalSeconds ?? null)}</strong></div>
          <div><span>Longest completed opening</span><strong>{duration(door?.longestSeconds ?? null)}</strong></div>
        </div>
        <p className="analytics-detail-note">
          {door?.completedPeriods
            ? door.completedPeriods + " completed opening period(s) had enough data for durations. "
            : "No complete opening period with a usable duration was returned. "}
          Durations exclude an opening still in progress.
          {door?.unmatchedOpen && " An OPEN event has no matching CLOSED event in the returned records."}
        </p>
        <p className="analytics-cap-note">
          The endpoint returns at most 100 recent events. Earlier openings and durations are outside this view; an opening near the cutoff may have no matching close event.
        </p>
      </article>
    </div>
  </section>;
}
