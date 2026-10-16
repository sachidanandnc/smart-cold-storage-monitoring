# Phase 22: deploy Smart Cold Storage on free tiers

This guide uses one Render Free **Web Service** for `backend`, one Render **Static Site** for `dashboard`, and the existing MongoDB Atlas Free cluster. The ESP8266 keeps sensing every five seconds. Do not upload `backend/.env` or `esp8266/firmware/wifi.h` to GitHub.

## What the rolling database does

Atlas Free allows 0.5 GB of documents **plus indexes** across the cluster. The backend checks Atlas's `atlasSize` every 30 seconds. At 420 MiB it begins removing the oldest fully processed sensor readings in batches, and continues until usage drops below 380 MiB. It never deletes the latest live reading or an unfinished reading, and waits at least one minute before a new reading can be trimmed. If no eligible sensor history remains, it trims resolved alerts, then closed door events. Active alerts and an open door event remain. This is irreversible rolling history, so export records you need before they age out. It is not a fixed time window; the actual number of days depends on document size and the other data stored in the cluster. The ESP's separate LittleFS queue still removes files only after a matching server ACK.

If Atlas is already at its hard quota, a write may receive HTTP 503 while cleanup runs. The ESP retains that reading in LittleFS and retries. If unrelated databases consume most of the cluster, this app cannot free their data and uploads can remain blocked. Check cluster usage locally with `cd backend` then `npm run storage` (requires the private `.env`).

## 1. Prepare Atlas

Use the existing Free cluster and a database user with `readWrite` access only to this app's database. Keep the MongoDB connection string private. Render Free outbound IP addresses are not fixed; Atlas may require an IP access-list entry of `0.0.0.0/0` for this service. That broadens network reach to Atlas, so use a strong dedicated database password and least-privilege database user. Do not turn off Atlas authentication. If you prefer a narrow IP allowlist, use hosting with fixed outbound IP instead.

## 2. Create the backend on Render

In [Render Dashboard](https://dashboard.render.com/), choose **New → Web Service**, connect `sachidanandnc/smart-cold-storage-monitoring`, and select the `phase22-cloud-deployment` branch. Use:

| Render field | Value |
|---|---|
| Plan | Free |
| Language | Node |
| Root directory | `backend` |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/` |

Add these **backend environment variables** in Render, not GitHub:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | Your existing Atlas connection string |
| `TEMP_MIN`, `TEMP_MAX`, `HUMIDITY_MIN`, `HUMIDITY_MAX` | Copy your existing private backend values |
| `DOOR_WARNING_SECONDS`, `DOOR_CRITICAL_SECONDS` | Copy your existing private backend values |
| `DEVICE_ID` | `cold-storage-01` |
| `DEVICE_API_KEY` | New random secret, at least 32 characters |
| `DASHBOARD_READ_KEY` | A **different** random secret, at least 32 characters |
| `CORS_ORIGIN` | Initially `http://localhost:5173`; replace with exact static-site URL in step 3 |
| `STORAGE_HIGH_WATER_MIB` | `420` |
| `STORAGE_LOW_WATER_MIB` | `380` |

Generate each key locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Run it twice and save the two results privately. Do not paste either key into chat or a GitHub issue. The device key goes into private `wifi.h` later; the dashboard read key is entered into the dashboard in your browser. Never put either key in a `VITE_` variable.

Deploy the backend. Its URL will be `https://<backend-name>.onrender.com`. Open that URL: `/` should return `status: online`. A browser visit to `/api/risk/current` without the read key should return HTTP 401. If the service fails to start, check Render logs first; the common causes are a missing environment variable or Atlas network access.

## 3. Create the dashboard on Render

Choose **New → Static Site** using the same repository and branch:

| Render field | Value |
|---|---|
| Root directory | `dashboard` |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |
| Environment variable | `VITE_API_BASE_URL=https://<your-backend>.onrender.com` |

Use your actual backend URL, without a trailing slash. After the static site receives its `https://<site-name>.onrender.com` URL, update the backend's `CORS_ORIGIN` to that **exact origin** and let Render redeploy the backend. Open the dashboard; it should ask for the `DASHBOARD_READ_KEY`. Enter it there. The key is kept in that browser tab's session storage, not in the public site build. If the dashboard says it cannot connect, verify the exact two URLs and the backend logs.

## 4. Switch the ESP8266 to verified HTTPS

Do this only after the backend URL exists. In your private `esp8266/firmware/wifi.h`, retain your working `MY_WIFI_SSID` and `MY_WIFI_PASSWORD`. Define `CLOUD_API_HOST` as the backend hostname only, `DEVICE_API_KEY` as the same key configured on Render, and `SERVER_ROOT_CA` as the public root CA certificate that validates the Render hostname. The public `wifi.example.h` shows the required names. Do not use `setInsecure()`. Send me the **public backend URL only** after step 2, and I can identify the correct root CA and give you an exact ready-to-paste `wifi.h` section without your secrets.

On reconnect, the device waits for NTP before verified HTTPS because TLS certificate dates need a valid clock. While Wi-Fi, NTP, or Render is unavailable, new readings stay in LittleFS. A failed POST or missing ACK also keeps the reading queued. The existing queue can hold up to 400 readings, about 33 minutes at a five-second sample interval; beyond that, the oldest unacknowledged local reading is evicted so the newest can be kept. A Render Free backend may sleep after 15 minutes without requests and take roughly a minute to wake; the ESP retries.

## 5. Verify end to end

1. With Wi-Fi and backend available, confirm `HTTP Response Code: 201` or `200` and a matching `ACK ...; pending=...` in the Arduino Serial Monitor. Confirm the dashboard live cards update.
2. Turn off the router temporarily. The LCD should keep showing current readings; Serial should show `Queued ...; pending=...`. The dashboard should mark the last live reading delayed.
3. Restore Wi-Fi. Confirm pending count falls and backfilled readings appear in history, while only fresh readings update live cards and alerts.
4. Reset the ESP during a queued backlog. The pending count should persist. Do not format LittleFS or change the IDE FS partition layout while it contains unacknowledged readings.
5. Confirm the dashboard's history shows capture and receipt times separately. A reading captured before NTP may have unknown capture time; receipt time remains available.
6. In Render logs, watch for `Atlas storage ... removed ...` only when the configured high watermark is reached. The backend checks usage without deleting anything while under that mark.

Render Free and Atlas Free quotas can change; check their current [Render Free](https://render.com/docs/free) and [Atlas Free](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) documentation before relying on the service for critical monitoring. A static website cannot keep monitoring if the ESP loses power or its 400-file queue overflows; do not treat the dashboard as a safety alarm on its own.
