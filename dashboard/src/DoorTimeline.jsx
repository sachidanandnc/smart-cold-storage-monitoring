import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { doorDuration, doorTime, doorTimeline, doorStateRows, normalizeDoorPeriods } from "./doorActivity";
import "./DoorTimeline.css";

function DoorTooltip({ active, payload }) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.doorState === null) return null;
  const opening = point.opening;
  return <div className="chart-tooltip door-state-tooltip">
    <span>{doorTime(point.time, true)} IST</span>
    <strong>{point.doorState === 1 ? "Open" : "Closed"}</strong>
    {point.doorState === 1 && (opening ? <>
      <span>Opened {doorTime(opening.openedAt, true)} IST</span>
      {opening.uncertain ? <span>Duration uncertain</span> : opening.completed ? <>
        <span>Closed {doorTime(opening.closedAt, true)} IST</span>
        <span>Total open time: {doorDuration(opening.durationSeconds)}</span>
      </> : <span>Observed open: {doorDuration((point.time - opening.openedAt) / 1000)} · close not recorded</span>}
    </> : <span>Observed open for {doorDuration(point.observedSeconds)} in this window; exact opening time unavailable.</span>)}
  </div>;
}

export default function DoorTimeline({ events, rows, sensor, stale, pending, failed }) {
  const periods = useMemo(() => normalizeDoorPeriods(events.data), [events.data]);
  const points = useMemo(() => doorStateRows(rows, periods), [rows, periods]);
  const known = points.filter(point => point.doorState !== null);
  const first = points[0]?.time ?? null;
  const last = points.at(-1)?.time ?? null;
  const observedAt = sensor?.doorOpen === true ? new Date(sensor.timestamp).getTime() : null;
  const visible = doorTimeline(periods, first, last, Number.isFinite(observedAt) ? observedAt : null);
  const completed = visible.filter(item => item.completed && !item.uncertain);
  const total = !completed.length && visible.some(item => item.completed && item.uncertain) ? null
    : completed.reduce((sum, item) => sum + (item.to - item.from) / 1000, 0);
  const latest = sensor?.doorOpen === true ? "Open" : sensor?.doorOpen === false ? "Closed" : "Unknown";

  return <article className="chart-panel door-timeline" aria-labelledby="door-timeline-title">
    <div className="chart-header"><div><div className="chart-title"><span className="chart-dot" /><h3 id="door-timeline-title">Door status</h3></div><p className="chart-subtitle">Open / closed over time · IST</p></div><div className="chart-value"><small>{stale ? "Last received reading" : "Latest reading"}</small><strong>{latest}</strong></div></div>
    {known.length ? <>
      <p className="visually-hidden">Door status over {known.length} readings. Open is the upper line and Closed is the lower line. Exact states are in the readings table.</p>
      <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={points} margin={{ top: 18, right: 12, left: 0, bottom: 4 }} accessibilityLayer>
          <defs><linearGradient id="fill-door-state" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--warning)" stopOpacity={0.18} /><stop offset="100%" stopColor="var(--warning)" stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
          <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={time => doorTime(time)} tick={{ fill: "var(--chart-axis)", fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={45} tickMargin={12} />
          <YAxis domain={[0, 1]} ticks={[0, 1]} tickFormatter={state => state === 1 ? "Open" : "Closed"} width={56} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip content={<DoorTooltip />} cursor={{ stroke: "var(--warning)", strokeDasharray: "3 4", opacity: .5 }} />
          <Area name="Door status" type="stepAfter" dataKey="doorState" stroke="var(--warning)" fill="url(#fill-door-state)" strokeWidth={2.3} dot={known.length === 1 || known.length < points.length ? { r: 2.5 } : false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 3 }} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ResponsiveContainer></div>
    </> : <div className="chart-empty" role="status"><strong>{pending ? "Loading door readings…" : failed ? "Door readings unavailable" : rows.length ? "Door capture times unavailable" : "No readings yet"}</strong><span>Door states need a known capture time. Gaps are left unconnected.</span></div>}
    {events.error && <p className="door-timeline-note" role="status">Door durations could not be refreshed. Sensor states are shown independently. <button type="button" onClick={events.retry} disabled={events.pending}>Retry</button></p>}
    <div className="chart-footer"><span>Open readings <strong>{known.length ? known.filter(point => point.doorState === 1).length : "—"}</strong></span><span>Completed open time <strong>{events.data === null || events.error || first === null ? "—" : doorDuration(total)}</strong></span><span>Hover for times and duration</span></div>
  </article>;
}
