import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import "./App.css";
import AnalyticsSection from "./AnalyticsSection";
import { API_BASE, readHeaders, savedReadKey, saveReadKey } from "./api";

// Keep the existing backend endpoints.
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
// This is a UI freshness indicator, not a storage safety threshold.
const READING_DELAY_MS = 30000;

function Icon({ name, size = 20, ...props }) {
  const paths = {
    snow: <><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4M20 14l-4 1 1 4M4 14l4 1-1 4M20 10l-4-1 1-4" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    trend: <><path d="M3 3v18h18M6 15l4-5 4 3 6-7" /></>,
    analytics: <><path d="M3 21h18M5 18v-6h3v6M11 18V5h3v13M17 18V9h3v9" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    temperature: <><path d="M9 14.8V5a3 3 0 0 1 6 0v9.8a5 5 0 1 1-6 0Z" /><path d="M12 8v10" /><circle cx="12" cy="18" r="1" /></>,
    humidity: <><path d="M12 3S5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-7-12-7-12Z" /><path d="M8 15a4 4 0 0 0 4 4" /></>,
    door: <><path d="M4 21h16M6 21V3h12v18M14 12h1" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14a8 8 0 0 0 13.4 3.9" /></>,
    moon: <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.grid}</svg>;
}

function number(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && value.trim() === "")) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function format(value, digits = 1) {
  const n = number(value);
  return n === null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function timeValue(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function timeLabel(value, full = false) {
  const timestamp = timeValue(value);
  if (timestamp === null) return "Time unavailable";
  return new Date(timestamp).toLocaleString(undefined, full
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
}

function validateCurrent(payload) {
  if (!payload || !payload.sensorData || typeof payload.sensorData !== "object" ||
      !payload.risk || typeof payload.risk !== "object") throw new Error("Invalid current response");
  return payload;
}

function validateHistory(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("Invalid history response");
  return payload.data.filter(row => row && typeof row === "object").map(row => ({
    timestamp: row.timestamp,
    time: timeValue(row.timestamp),
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    historical: row.historical === true,
    liveEligible: row.liveEligible === true,
    readingId: row.readingId,
    temperature: number(row.temperature),
    humidity: number(row.humidity),
    riskScore: number(row.riskScore),
    riskLevel: typeof row.riskLevel === "string" ? row.riskLevel.trim().toUpperCase() : null,
  })).sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

// Each endpoint polls independently. Slow requests never overlap; cleanup
// cancels in-flight requests, including when the history limit changes.
function usePolling(url, validate, errorMessage, readKey) {
  const [state, setState] = useState({ url, data: null, error: "", pending: true });
  const refreshRef = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let controller = null;
    let busy = false;
    let timeout;
    setState(previous => previous.url === url ? previous : { url, data: null, error: "", pending: true });
    async function refresh() {
      if (busy || disposed) return;
      busy = true;
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      setState(previous => ({ ...previous, pending: true }));
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers: readHeaders(readKey) });
        if (response.status === 401) throw new Error("Access key required or incorrect.");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = validate(await response.json());
        if (!disposed) setState({ url, data, error: "", pending: false });
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, error: error?.message === "Access key required or incorrect." ? error.message : errorMessage, pending: false }));
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    }
    refreshRef.current = refresh;
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [url, validate, errorMessage, readKey]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...(state.url === url ? state : { data: null, error: "", pending: true }), refresh };
}

function Sparkline({ rows, dataKey }) {
  if (rows.filter(row => row[dataKey] !== null).length < 2) return null;
  return <div className="mini-chart" aria-hidden="true"><ResponsiveContainer width="100%" height="100%">
    <AreaChart data={rows.slice(-20)}><Area type="linear" dataKey={dataKey} stroke="currentColor" fill="currentColor" fillOpacity={0.08} strokeWidth={1.8} isAnimationActive={false} dot={false} /></AreaChart>
  </ResponsiveContainer></div>;
}

function MetricCard({ title, icon, tone, value, unit, caption, rows, dataKey, indicator, attention, loading }) {
  return <article className={"metric-card" + (attention ? " is-attention" : "")}>
    <div className="metric-label"><h2>{title}</h2><span className={"metric-icon tone-" + tone}><Icon name={icon} /></span></div>
    {loading ? <><div className="skeleton skeleton-value" /><div className="skeleton skeleton-line" /></> : <>
      <div className="metric-reading"><strong>{value}</strong>{unit && <span>{unit}</span>}</div>
      <div className="metric-bottom"><span className="metric-caption">{caption}</span>
        {dataKey ? <Sparkline rows={rows} dataKey={dataKey} /> : <span className={"metric-indicator tone-" + tone}>{indicator}</span>}
      </div>
    </>}
  </article>;
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><span>{timeLabel(label, true)}</span><strong>{format(payload[0].value)} <small>{unit}</small></strong></div>;
}

function HistoryChart({ title, subtitle, rows, dataKey, unit, color, current, wide, pending, failed }) {
  const values = rows.map(row => row[dataKey]).filter(value => value !== null);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return <article className={"chart-panel" + (wide ? " chart-wide" : "")} aria-labelledby={dataKey + "-title"}>
    <div className="chart-header"><div><div className="chart-title"><span className="chart-dot" style={{ background: color }} /><h3 id={dataKey + "-title"}>{title}</h3></div><p className="chart-subtitle">{subtitle}</p></div>
      <div className="chart-value"><small>Latest reading</small><strong>{format(current, dataKey === "riskScore" ? 0 : 1)}</strong><span>{unit}</span></div>
    </div>
    {values.length ? <>
      <p className="visually-hidden">{title} over {rows.length} timestamped readings. Minimum {format(min)} {unit}, maximum {format(max)} {unit}. Exact readings are in the data table below.</p>
      <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={rows} margin={{ top: 14, right: 12, left: -12, bottom: 4 }} accessibilityLayer>
          <defs><linearGradient id={"fill-" + dataKey} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.18} /><stop offset="100%" stopColor={color} stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
          <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={time => timeLabel(time)} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={45} tickMargin={12} />
          <YAxis domain={dataKey === "riskScore" ? [0, 100] : ["auto", "auto"]} width={48} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} tickCount={5} />
          <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: color, strokeDasharray: "3 4", opacity: 0.5 }} />
          <Area name={title} type="linear" dataKey={dataKey} stroke={color} fill={"url(#fill-" + dataKey + ")"} strokeWidth={2.3} dot={values.length < rows.length || values.length === 1 ? { r: 3, strokeWidth: 1 } : false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 3 }} isAnimationActive={false} connectNulls={false} />
        </AreaChart>
      </ResponsiveContainer></div>
    </> : <div className="chart-empty" role="status"><Icon name="trend" size={28} /><strong>{pending ? "Loading readings…" : failed ? "History unavailable" : "No readings yet"}</strong><span>{pending ? "Retrieving recent sensor history." : failed ? "Use Retry history to reconnect." : "Recorded readings will appear here automatically."}</span></div>}
    <div className="chart-footer"><span>Min <strong>{format(min)}{unit === "/100" ? "" : unit}</strong></span><span>Average <strong>{format(average)}{unit === "/100" ? "" : unit}</strong></span><span>Max <strong>{format(max)}{unit === "/100" ? "" : unit}</strong></span></div>
  </article>;
}

function DashboardAccess({ onConnect }) {
  const dialog = useRef(null);
  const [key, setKey] = useState("");
  return <>
    <button type="button" className="button" onClick={() => dialog.current.showModal()}><Icon name="shield" size={16} />Access</button>
    <dialog ref={dialog} className="access-dialog" aria-labelledby="access-title" aria-describedby="access-description">
      <form onSubmit={event => {
        event.preventDefault();
        const value = key.trim();
        if (!value) return;
        saveReadKey(value);
        onConnect(value);
        setKey("");
        dialog.current.close();
      }}>
        <h2 id="access-title">Unlock dashboard</h2>
        <p id="access-description">Enter your dashboard access key to view protected readings.</p>
        <label htmlFor="dashboard-key">Access key</label>
        <input id="dashboard-key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} required />
        <div className="access-dialog-actions">
          <button className="button" type="button" onClick={() => { setKey(""); dialog.current.close(); }}>Cancel</button>
          <button className="button" type="submit">Connect</button>
        </div>
      </form>
    </dialog>
  </>;
}

export default function App({ previewMode = false }) {
  const [historyLimit, setHistoryLimit] = useState(50);
  const [now, setNow] = useState(Date.now);
  const [activeSection, setActiveSection] = useState("overview");
  const [readKey, setReadKey] = useState(savedReadKey);
  const current = usePolling(API_BASE + "/api/risk/current", validateCurrent, "Unable to connect to the cold-storage backend.", readKey);
  const history = usePolling(API_BASE + "/api/sensor-data/history?limit=" + historyLimit, validateHistory, "Unable to load historical readings.", readKey);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.find(entry => entry.isIntersecting);
      if (visible) setActiveSection(visible.target.id);
    }, { rootMargin: "-10% 0px -65% 0px" });
    ["overview", "risk", "history", "analytics"].forEach(id => {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    });
    return () => observer.disconnect();
  }, []);

  const sensor = current.data?.sensorData;
  const risk = current.data?.risk;
  const riskLevel = typeof risk?.level === "string" ? risk.level.toUpperCase() : "UNKNOWN";
  const riskClass = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(riskLevel) ? riskLevel.toLowerCase() : "unknown";
  const score = number(risk?.score);
  const reasons = Array.isArray(risk?.reasons) ? risk.reasons.filter(reason => typeof reason === "string" && reason.trim()) : [];
  const rows = history.data || [];
  const chartRows = useMemo(() => (history.data || []).filter(row => row.time !== null), [history.data]);
  const readingTime = timeValue(sensor?.timestamp);
  const delayed = current.data && (readingTime === null || now - readingTime > READING_DELAY_MS || readingTime - now > READING_DELAY_MS);
  const stale = Boolean(current.error || delayed);
  const loading = !current.data && current.pending && !current.error;
  const connectionLabel = current.error === "Access key required or incorrect." ? "Access required" : current.error ? "Connection interrupted" : !current.data ? "Connecting" : delayed ? "Reading delayed" : "Connected";
  const doorOpen = sensor?.doorOpen === true || sensor?.doorOpen === 1 || sensor?.doorOpen === "true";
  const doorClosed = sensor?.doorOpen === false || sensor?.doorOpen === 0 || sensor?.doorOpen === "false";
  const deviceId = typeof sensor?.deviceId === "string" && sensor.deviceId.trim() ? sensor.deviceId : "Storage unit";
  const caption = !current.data ? "Waiting for a reading" : stale ? "Last received reading" : "Latest sensor reading";
  const refreshAll = () => { current.refresh(); history.refresh(); };
  const riskTitle = !current.data ? "Awaiting risk assessment" : stale ? "Last recorded assessment" : ({ low: "Low environmental risk", medium: "Conditions need attention", high: "Elevated environmental risk", critical: "Critical environmental risk", unknown: "Risk level unavailable" })[riskClass];

  return <div className="cold-app">
    <a className="skip-link" href="#main">Skip to dashboard</a>
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="Smart Cold Storage overview"><span className="brand-mark"><Icon name="snow" size={27} /></span><span><strong>Smart Cold</strong><span>STORAGE MONITORING</span></span></a>
      <p className="workspace-label">WORKSPACE</p>
      <nav className="side-nav" aria-label="Dashboard sections">
        {[["overview", "grid", "Overview"], ["risk", "shield", "Risk analysis"], ["history", "trend", "Sensor history"], ["analytics", "analytics", "Analytics"]].map(([id, icon, label]) =>
          <a key={id} className={activeSection === id ? "active" : ""} aria-current={activeSection === id ? "location" : undefined} href={"#" + id} onClick={() => setActiveSection(id)}><Icon name={icon} /><span>{label}</span>{activeSection === id && <Icon name="arrow" size={14} />}</a>)}
      </nav>
      <div className="sidebar-bottom"><div className="node-card"><span className="node-icon"><Icon name="server" /></span><p className="node-caption">MONITORED DEVICE</p><strong className="node-id">{deviceId}</strong><div className="node-foot"><span className={"status-dot" + (stale || !current.data ? " is-muted" : "")} />{previewMode ? "Preview device" : "Single storage unit"}</div></div><p className="sidebar-note"><Icon name="snow" size={14} /> Precision in every degree.</p></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="arrow" size={13} /><strong>Cold storage</strong></div><div className="topbar-actions">{!previewMode && <DashboardAccess onConnect={key => { if (key === readKey) { current.refresh(); history.refresh(); } else setReadKey(key); }} />}<span className="polling-note"><Icon name="clock" size={14} /> Updates every 5 seconds</span></div></header>
      <main className="dashboard" id="main" tabIndex={-1}>
        <section className="page-heading" id="overview" aria-labelledby="page-title"><div><p className="eyebrow"><span className="status-dot" /> ENVIRONMENTAL MONITORING</p><h1 id="page-title">Storage overview<span>.</span></h1><p className="page-description">A clear view of your storage. Confidence in every reading.</p></div><div className="heading-actions"><span className={"connection-badge" + (stale || !current.data ? " is-muted" : "")} role="status"><span className="status-dot" />{previewMode && current.data ? "Demo data" : connectionLabel}</span><button type="button" className="button refresh-button" onClick={refreshAll} disabled={current.pending && history.pending}><Icon name="refresh" size={16} />Refresh</button></div></section>

        {previewMode && <div className="notice notice-info"><Icon name="grid" /><div><strong>Design preview</strong><p>Illustrative sensor data. Your replacement App.jsx connects to your existing backend.</p></div></div>}
        {delayed && !current.error && <div className="notice notice-warning" role="status"><Icon name="clock" /><div><strong>Sensor reading is delayed</strong><p>The backend is reachable, but the reading timestamp is missing, outside the last 30 seconds, or ahead of this device's clock. Last reading: {timeLabel(sensor?.timestamp, true)}.</p></div></div>}
        {loading && <p className="loading-label" role="status">Connecting to cold storage…</p>}

        <section className="metric-grid" aria-label="Latest sensor readings" aria-busy={loading}>
          <MetricCard title="Temperature" icon="temperature" tone="temperature" value={format(sensor?.temperature)} unit="°C" caption={caption} rows={chartRows} dataKey="temperature" loading={loading} />
          <MetricCard title="Relative humidity" icon="humidity" tone="humidity" value={format(sensor?.humidity)} unit="%" caption={caption} rows={chartRows} dataKey="humidity" loading={loading} />
          <MetricCard title="Storage door" icon="door" tone="door" value={doorOpen ? "Open" : doorClosed ? "Closed" : "Unknown"} caption={!current.data ? "Waiting for door status" : stale ? "Last received door status" : doorOpen ? "Door is currently open" : doorClosed ? "Door is secured" : "Door status unavailable"} indicator={<Icon name={doorClosed ? "check" : "warning"} size={17} />} attention={doorOpen} loading={loading} />
          <MetricCard title="Environmental risk" icon="shield" tone="risk" value={format(score, 0)} unit="/100" caption={stale ? "Last recorded assessment" : "Backend risk assessment"} indicator={<span className={"risk-badge " + riskClass}>{riskLevel}</span>} loading={loading} />
        </section>

        <section className={"risk-panel " + (current.data ? riskClass : "unknown") + (stale ? " is-stale" : "")} id="risk" aria-labelledby="risk-title">
          <div className="risk-intro"><p className="section-kicker">STORAGE CONDITION</p><div className="risk-headline"><Icon name={riskClass === "low" && !stale ? "shield" : "warning"} size={25} /><h2 id="risk-title">{riskTitle}</h2></div><p>Temperature, humidity and door-open duration inform your storage risk.</p></div>
          <div className="risk-meter"><div className="risk-number"><strong>{format(score, 0)}</strong><span>/ 100 <span>risk score</span></span></div><div className="risk-track" {...(score === null ? {} : { role: "meter", "aria-label": "Environmental risk score", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.max(0, Math.min(score, 100)), "aria-valuetext": format(score, 0) + " of 100, " + riskLevel + (stale ? ", last recorded assessment" : "") })}><span className="risk-fill" style={{ width: Math.max(0, Math.min(score ?? 0, 100)) + "%" }} /></div><div className="risk-scale"><span>0 · Lower risk</span><span>100 · Higher risk</span></div></div>
          <div className="risk-explanation"><h3>Assessment details <span className={"risk-badge " + riskClass}>{riskLevel}</span></h3>{reasons.length ? <ul className="reason-list">{reasons.map((reason, index) => <li key={index}><Icon name={riskClass === "low" ? "check" : "arrow"} size={15} /><span>{reason}</span></li>)}</ul> : <p>{current.data ? "No assessment details were supplied by the backend." : "Assessment details will appear when connected."}</p>}</div>
        </section>

        <section className="history-section" id="history" aria-labelledby="history-title">
          <div className="section-header"><div><p className="eyebrow">THE BIGGER PICTURE</p><h2 id="history-title">Environmental trends</h2><p>Your recent readings, with the detail that matters.</p></div><div className="history-controls"><label htmlFor="history-limit">History window</label><select id="history-limit" value={historyLimit} onChange={event => setHistoryLimit(Number(event.target.value))}>{[25, 50, 100, 250, 500].map(limit => <option value={limit} key={limit}>Last {limit} readings</option>)}</select></div></div>
          {history.error && <div className="notice notice-warning"><Icon name="warning" /><div role="alert"><strong>{history.error}</strong><p>{rows.length ? "Charts show the last successful history response." : "Current sensor readings are shown independently."}</p></div><button className="button" type="button" disabled={history.pending} onClick={history.refresh}>{history.pending ? "Retrying…" : "Retry history"}</button></div>}
          <p className="chart-summary">Offline readings appear here as they reach the server. If the device clock was unavailable, the chart uses server receipt time; the table marks the capture time as unknown. Live cards wait for a fresh reading. Oldest stored history is removed when the free database approaches its storage limit.</p>
          {rows.length > chartRows.length && <p className="chart-summary">{rows.length - chartRows.length} reading(s) have an invalid timestamp and appear only in the data table.</p>}
          <div className="chart-grid">
            <HistoryChart title="Temperature" subtitle="Cold storage air temperature" rows={chartRows} dataKey="temperature" unit="°C" color="var(--temperature)" current={sensor?.temperature} pending={history.pending && !history.data && !history.error} failed={Boolean(history.error)} />
            <HistoryChart title="Relative humidity" subtitle="Moisture level inside storage" rows={chartRows} dataKey="humidity" unit="%" color="var(--humidity)" current={sensor?.humidity} pending={history.pending && !history.data && !history.error} failed={Boolean(history.error)} />
            <HistoryChart title="Environmental risk" subtitle="Recorded risk scores · 0–100 scale" rows={chartRows} dataKey="riskScore" unit="/100" color="var(--risk-chart)" current={score} wide pending={history.pending && !history.data && !history.error} failed={Boolean(history.error)} />
          </div>
          <div className="history-table"><details><summary>View reading data <span>{rows.length} readings</span></summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Sensor readings table"><table><caption>History returned by the backend, oldest first. Times use your browser's timezone. Unknown capture times are shown at server receipt time in charts.</caption><thead><tr><th scope="col">Captured at</th><th scope="col">Server received</th><th scope="col">Delivery</th><th scope="col">Temperature (°C)</th><th scope="col">Humidity (%)</th><th scope="col">Risk (/100)</th><th scope="col">Risk level</th></tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={row.readingId || index}><td>{row.capturedAt ? timeLabel(row.capturedAt, true) : "Unknown (not recorded)"}</td><td>{timeLabel(row.receivedAt, true)}</td><td>{row.historical ? "Backfilled" : row.liveEligible ? "Live" : "Recorded"}</td><td>{format(row.temperature)}</td><td>{format(row.humidity)}</td><td>{format(row.riskScore, 0)}</td><td>{row.riskLevel || "—"}</td></tr>) : <tr><td colSpan={7}>No history readings available.</td></tr>}</tbody></table></div></details></div>
        </section>
        <AnalyticsSection historyData={chartRows} historyLimit={historyLimit}
          historyPending={history.pending && !history.data} historyError={history.error} readKey={readKey} />
        <footer className="dashboard-footer"><span className="footer-brand"><Icon name="snow" size={16} /> Smart Cold Storage</span><span>Last sensor reading <strong>{timeLabel(sensor?.timestamp, true)}</strong></span></footer>
      </main>
    </div>
  </div>;
}
