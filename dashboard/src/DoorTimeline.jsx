import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { doorDuration, doorTime, doorTimeline, doorDurationRows, normalizeDoorPeriods } from "./doorActivity";
import "./DoorTimeline.css";

function DoorTooltip({ active, payload }) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.openSeconds === null) return null;
  const opening = point.opening;
  return <div className="chart-tooltip door-state-tooltip">
    <span>{doorTime(point.time, true)} IST</span>
    <strong>{point.boundary === "close" ? "Completed opening · " + doorDuration(point.openSeconds)
      : point.doorState === 0 ? "Closed · 0s"
        : "Open for " + (point.estimated ? "≥ " : "") + doorDuration(point.openSeconds)}</strong>
    {opening ? <>
      <span>Opened {doorTime(opening.openedAt, true)} IST</span>
      {opening.completed ? <>
        <span>Closed {doorTime(opening.closedAt, true)} IST</span>
        <span>Total open time: {doorDuration(opening.durationSeconds)}</span>
      </> : <span>Close time not recorded</span>}
    </> : point.doorState === 1 && <span>Measured since the first open sample in this window. Exact opening time is unavailable.</span>}
  </div>;
}

export default function DoorTimeline({ events, rows, sensor, stale, pending, failed }) {
  const periods = useMemo(() => normalizeDoorPeriods(events.data), [events.data]);
  const points = useMemo(() => doorDurationRows(rows, periods), [rows, periods]);
  const known = points.filter(point => point.openSeconds !== null);
  const latest = known.at(-1);
  const maxObserved = known.length ? Math.max(...known.map(point => point.openSeconds)) : null;
  const tickStep = Math.max(5, Math.ceil((maxObserved ?? 5) / 25) * 5);
  const axisMax = Math.max(5, Math.ceil((maxObserved ?? 0) / tickStep) * tickStep);
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, index) => index * tickStep);
  const observedAt = sensor?.doorOpen === true ? new Date(sensor.timestamp).getTime() : null;
  const visible = doorTimeline(periods, points[0]?.time ?? null, points.at(-1)?.time ?? null, Number.isFinite(observedAt) ? observedAt : null);
  const estimates = points.some(point => point.estimated);
  const uncertain = points.some(point => point.opening?.uncertain);

  return <article className="chart-panel door-timeline" aria-labelledby="door-timeline-title">
    <div className="chart-header"><div><div className="chart-title"><span className="chart-dot" /><h3 id="door-timeline-title">Door open duration</h3></div><p className="chart-subtitle">Seconds open over time · IST</p></div><div className="chart-value"><small>{stale ? "Last available reading" : "Latest recorded"}</small><strong>{latest ? (latest.estimated ? "≥ " : "") + latest.openSeconds.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"}</strong><span>s</span></div></div>
    {known.length ? <>
      <p className="visually-hidden">Elapsed seconds open, rising during each opening and resetting to zero at closure. Missing intervals are not connected. Opening and closing times are available in the expandable opening periods table.</p>
      <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={points} margin={{ top: 14, right: 12, left: -4, bottom: 4 }} accessibilityLayer>
          <defs><linearGradient id="fill-door-duration" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--warning)" stopOpacity={0.18} /><stop offset="100%" stopColor="var(--warning)" stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
          <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={time => doorTime(time)} tick={{ fill: "var(--chart-axis)", fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={45} tickMargin={12} />
          <YAxis domain={[0, axisMax]} ticks={ticks} tickFormatter={seconds => seconds + "s"} allowDecimals={false} width={52} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip content={<DoorTooltip />} cursor={{ stroke: "var(--warning)", strokeDasharray: "3 4", opacity: .5 }} />
          <Area name="Seconds open" type="linear" dataKey="openSeconds" stroke="var(--warning)" fill="url(#fill-door-duration)" strokeWidth={2.3} dot={known.length === 1 || known.length < points.length ? { r: 2.5 } : false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 3 }} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ResponsiveContainer></div>
    </> : <div className="chart-empty" role="status"><strong>{pending ? "Loading door readings…" : failed ? "Door readings unavailable" : rows.length ? "Door duration unavailable" : "No readings yet"}</strong><span>Known capture times are needed to measure elapsed time.</span></div>}
    {(estimates || uncertain || events.error) && <p className="door-timeline-note" role="status">{events.error ? "Opening records could not refresh. " : ""}{estimates && "≥ values are measured from the first open sample; the actual opening may be earlier. "}{uncertain && "Uncertain durations are left blank."}</p>}
    <div className="chart-footer"><span>Max observed <strong>{doorDuration(maxObserved)}</strong></span><span>{rows.length} readings</span><span>Hover/tap for times and duration</span></div>
    {visible.length > 0 && <details className="door-opening-periods">
      <summary>Opening periods <span>{visible.length}</span></summary>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Door opening periods">
        <table><caption>IST · recorded events in this window, newest first · up to 100 recent event records</caption><thead><tr><th scope="col">Opened</th><th scope="col">Closed</th><th scope="col">Open for</th></tr></thead><tbody>{[...visible].reverse().map(item => <tr key={item.key}><td>{doorTime(item.openedAt, true)}</td><td>{item.uncertain || !item.completed ? "Not confirmed" : doorTime(item.closedAt, true)}</td><td>{item.uncertain ? "Uncertain" : item.completed ? doorDuration(item.durationSeconds) : "Not complete"}</td></tr>)}</tbody></table>
      </div>
    </details>}
  </article>;
}
