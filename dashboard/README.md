# Smart Cold Storage dashboard

React/Vite/Recharts frontend for the Smart Cold Storage Monitoring System.

[Open the dashboard](https://smart-cold-storage-monitoring-system.onrender.com/)

## Setup

Use Node.js 22.12 or newer, compatible with the Vite dependency requirements. Install dependencies with `npm ci`. Copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to the backend origin.

```env
VITE_API_BASE_URL=http://localhost:5000
```

For the deployed backend, use `https://smart-cold-storage-monitoring.onrender.com`. Run `npm run dev` for development. Run `npm run build` to produce `dist`. Vite embeds configuration at build time, so an environment change requires rebuilding and redeploying. Keep device keys and database credentials out of frontend configuration.

## Dashboard views

- Overview cards show the latest received temperature, humidity, door state and risk.
- Risk analysis explains the conditions contributing to the stored assessment.
- History includes temperature, humidity, risk and elapsed door-open duration charts.
- Charts are chronological; the expandable table shows the newest readings first.
- The reading window supports 25, 50, 100, 250, 500 and 1000 readings, defaulting to 100.
- Analytics includes valid-value minimum/average/maximum summaries, risk distribution and door-opening statistics.
- Door records marked CLOSED still count as completed openings. Uncertain durations are excluded from exact duration totals.

Door activity uses at most 100 recent event records from its separate endpoint. These totals are independent of the selected sensor-history count. Unclosed periods stop at the last supported observation, and gaps are not presented as precise open durations.

## Data and connection handling

API requests poll approximately every five seconds, with cancellation and timeouts. A 30-second freshness indicator distinguishes delayed readings from recent data. Capture and receipt times explain late delivery; an unknown capture time remains identifiable. The door timeline explicitly formats IST, while other labels use their formatter/browser locale.

Dashboard GET requests are public and require no dashboard access key. The backend authenticates sensor uploads separately. Communication uses REST polling.

## Checks

```bash
npm test
npm run lint
npm run build
```

See the [project README](../README.MD) for hardware wiring, firmware configuration, backend APIs, security and deployment.
