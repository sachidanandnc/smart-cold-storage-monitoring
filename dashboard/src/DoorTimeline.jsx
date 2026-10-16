import { useMemo, useState } from "react";
import { doorDuration, doorTime, doorTimeline, normalizeDoorPeriods } from "./doorActivity";
import "./DoorTimeline.css";

export default function DoorTimeline({ events, rows, sensor, stale }) {
  const [selectedKey, setSelectedKey] = useState(null);
  const periods = useMemo(() => normalizeDoorPeriods(events.data), [events.data]);
  const times = rows.map(row => row.time).filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;
  const observedAt = sensor?.doorOpen === true ? new Date(sensor.timestamp).getTime() : null;
  const visible = useMemo(() => doorTimeline(periods, first, last, Number.isFinite(observedAt) ? observedAt : null), [periods, first, last, observedAt]);
  const selected = visible.find(item => item.key === selectedKey) ?? visible.at(-1);
  const span = Math.max(1, (last ?? 0) - (first ?? 0));
  const completed = visible.filter(item => item.completed && !item.uncertain);
  const totalSeconds = !completed.length && visible.some(item => item.completed && item.uncertain) ? null
    : completed.reduce((sum, item) => sum + (item.to - item.from) / 1000, 0);
  const summary = item => `${doorTime(item.openedAt, true)} IST · ${item.uncertain ? "Duration uncertain" : item.completed ? doorDuration(item.durationSeconds) : "Close time not recorded"}`;

  return <article className="chart-panel door-timeline" aria-labelledby="door-timeline-title">
    <div className="chart-header"><div><div className="chart-title"><span className="chart-dot" /><h3 id="door-timeline-title">Door open timeline</h3></div><p className="chart-subtitle">Recorded open periods · IST</p></div><span className="door-period-count">{visible.length} periods</span></div>
    {events.error && <p className="door-timeline-note" role="status">{events.data ? "Showing last loaded door events." : events.error} <button type="button" onClick={events.retry} disabled={events.pending}>Retry</button></p>}
    {first !== null && last !== null && events.data !== null ? <>
      <div className="door-timeline-plot">
        <svg viewBox="0 0 1000 70" preserveAspectRatio="none" aria-label="Recorded door openings in the selected history window">
          <rect x="0" y="16" width="1000" height="36" rx="8" className="door-timeline-track" />
          {visible.map(item => <rect key={item.key} x={(item.from - first) / span * 996} y="16" width={Math.max(4, (item.to - item.from) / span * 996)} height="36" rx="3"
            className={"door-timeline-period" + (item.uncertain ? " is-uncertain" : "") + (item.key === selected?.key ? " is-selected" : "")}
            tabIndex={0} role="button" aria-label={summary(item)} aria-pressed={item.key === selected?.key}
            onClick={() => setSelectedKey(item.key)} onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); setSelectedKey(item.key); } }}>
            <title>{summary(item)}</title>
          </rect>)}
        </svg>
        <div className="door-timeline-axis"><span>{doorTime(first)}</span><span>{doorTime(first + span / 2)}</span><span>{doorTime(last)}</span></div>
      </div>
      {selected ? <div className="door-period-detail" aria-live="polite">
        <strong>{selected.uncertain ? "Duration uncertain" : selected.completed ? doorDuration(selected.durationSeconds) + " open" : selected.confirmedThrough ? "Open at last reading" : "Close time not recorded"}</strong>
        <span>Opened {doorTime(selected.openedAt, true)} IST</span>
        <span>{selected.completed ? (selected.uncertain ? "Segment ended " : "Closed ") + doorTime(selected.closedAt, true) + " IST" : selected.confirmedThrough ? "Observed through " + doorTime(selected.confirmedThrough, true) + " IST" : "No confirmed closing timestamp"}</span>
      </div> : <p className="door-timeline-empty">No recorded openings in this history window.</p>}
      <p className="door-timeline-note">Select a bar for details. Blank areas have no recorded opening.{visible.some(item => item.uncertain) && " Dashed bars have uncertain durations."}</p>
    </> : <div className="chart-empty" role="status"><strong>{events.pending ? "Loading door activity…" : events.error ? "Door history unavailable" : "Waiting for timestamped history"}</strong></div>}
    <div className="chart-footer"><span>Completed open time in window <strong>{events.data === null || first === null ? "—" : doorDuration(totalSeconds)}</strong></span><span>{stale || events.error ? "Last available data" : "Latest 100 event records"}</span></div>
  </article>;
}
