// ==========================================
// Imports
// ==========================================
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { createStorageMaintainer, storageLimitMiB } = require("./storage-maintenance");
require("dotenv").config();
// ==========================================
// Application Configuration
// ==========================================
const app = express();
// ==========================================
// Middleware
// ==========================================
app.set("trust proxy", 1);
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // ESP8266 and command-line requests have no browser Origin header.
    callback(null, !origin || allowedOrigins.includes(origin));
  },
}));
app.use(express.json({ limit: "8kb" }));
const PORT = process.env.PORT || 5000;
function matchesSecret(provided, expected) {
  if (!expected || typeof provided !== "string") return false;
  const actual = Buffer.from(provided);
  const configured = Buffer.from(expected);
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}
// Dashboard reads are public. Device uploads below still require X-Device-Key.
// A generous upload cap permits fast replay of the bounded offline queue.
const requestWindows = new Map();
app.use((req, res, next) => {
  const upload = req.method === "POST" && req.path === "/api/sensor-data";
  const read = req.method === "GET" && req.path.startsWith("/api/");
  if (!upload && !read) return next();
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const key = `${upload ? "upload" : "read"}:${ip}`;
  const window = requestWindows.get(key);
  const current = !window || now - window.started >= 60000
    ? { started: now, count: 0 } : window;
  current.count += 1;
  requestWindows.set(key, current);
  if (requestWindows.size > 1000) {
    for (const [address, value] of requestWindows) {
      if (now - value.started >= 60000) requestWindows.delete(address);
    }
    if (requestWindows.size > 1000) requestWindows.delete(requestWindows.keys().next().value);
  }
  if (current.count > (upload ? 900 : 180)) {
    return res.status(429).json({ success: false, message: "Request rate limit reached" });
  }
  next();
});
// Keep MongoDB dates in UTC. Only console output is localized for operators.
const istClock = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
function logTimeIST(value) {
  if (!value) return "unknown (device clock unavailable)";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown (invalid timestamp)"
    : istClock.format(date) + " IST";
}
// ==========================================
// Environment Variables / Thresholds
// ==========================================
const TEMP_MIN = Number(process.env.TEMP_MIN);
const TEMP_MAX = Number(process.env.TEMP_MAX);
const HUMIDITY_MIN = Number(process.env.HUMIDITY_MIN);
const HUMIDITY_MAX = Number(process.env.HUMIDITY_MAX);
const DOOR_WARNING_SECONDS = Number(process.env.DOOR_WARNING_SECONDS);
const DOOR_CRITICAL_SECONDS = Number(process.env.DOOR_CRITICAL_SECONDS);
const STORAGE_HIGH_WATER_MIB = storageLimitMiB(process.env.STORAGE_HIGH_WATER_MIB, 420);
const STORAGE_LOW_WATER_MIB = storageLimitMiB(process.env.STORAGE_LOW_WATER_MIB, 380);
if (STORAGE_HIGH_WATER_MIB > 470 || STORAGE_LOW_WATER_MIB >= STORAGE_HIGH_WATER_MIB) {
  throw new Error("Storage watermarks must leave room below the 512 MiB Atlas Free limit");
}
// Validate threshold configuration
if (
  Number.isNaN(TEMP_MIN) ||
  Number.isNaN(TEMP_MAX) ||
  Number.isNaN(HUMIDITY_MIN) ||
  Number.isNaN(HUMIDITY_MAX) ||
  Number.isNaN(DOOR_WARNING_SECONDS) ||
  Number.isNaN(DOOR_CRITICAL_SECONDS)
) {
  console.error("❌ Invalid or missing threshold values in .env");
  process.exit(1);
}
if (DOOR_WARNING_SECONDS >= DOOR_CRITICAL_SECONDS) {
  console.error(
    "❌ Door warning threshold must be less than critical threshold",
  );
  process.exit(1);
}
if (TEMP_MIN >= TEMP_MAX) {
  console.error("❌ TEMP_MIN must be less than TEMP_MAX");
  process.exit(1);
}
if (HUMIDITY_MIN >= HUMIDITY_MAX) {
  console.error("❌ HUMIDITY_MIN must be less than HUMIDITY_MAX");
  process.exit(1);
}
if (DOOR_WARNING_SECONDS <= 0 || DOOR_CRITICAL_SECONDS <= 0) {
  console.error("❌ Door thresholds must be greater than 0");
  process.exit(1);
}
// ==========================================
// MongoDB Connection
// ==========================================
async function connectDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error(error.message);
    process.exit(1);
  }
}
// ==========================================
// Sensor Data Schema
// ==========================================
const sensorDataSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      default: "cold-storage-01",
    },
    // readingId is stable across firmware retries. Older documents have no ID.
    readingId: { type: String },
    temperature: {
      type: Number,
      required: true,
    },
    humidity: {
      type: Number,
      required: true,
    },
    doorOpen: {
      type: Boolean,
      required: true,
    },
    riskScore: {
      type: Number,
      default: 0,
    },
    riskLevel: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "LOW",
    },
    riskReasons: {
      type: [String],
      default: [],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    capturedAt: { type: Date, default: null },
    receivedAt: { type: Date },
    timeQuality: { type: String, enum: ["ntp", "unknown", "legacy"] },
    historical: { type: Boolean },
    liveEligible: { type: Boolean },
    processingComplete: { type: Boolean, default: false },
    processingToken: { type: String },
    processingLeaseUntil: { type: Date },
    alertsGenerated: { type: Number, default: 0 },
    doorStatus: {
      doorOpen: Boolean,
      durationSeconds: Number,
      alertCreated: Boolean,
      alertEscalated: Boolean,
    },
  },
  {
    collection: "sensorData",
  },
);
sensorDataSchema.index({ deviceId: 1, readingId: 1 }, {
  unique: true,
  name: "device_reading_unique",
  // Existing readings from before Phase 21 have no readingId.
  partialFilterExpression: { readingId: { $type: "string" } },
});
sensorDataSchema.index({ liveEligible: 1, processingComplete: 1, timestamp: -1 });
sensorDataSchema.index({ deviceId: 1, capturedAt: -1 });
// ==========================================
// Alert Schema
// ==========================================
const alertSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      default: "cold-storage-01",
    },
    type: {
      type: String,
      required: true,
    },
    severity: {
      type: String,
      enum: ["WARNING", "CRITICAL"],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    value: {
      type: Number,
    },
    resolved: {
      type: Boolean,
      default: false,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "alerts",
  },
);
// ==========================================
// Door Event Schema
// ==========================================
const doorEventSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      default: "cold-storage-01",
    },
    openedAt: {
      type: Date,
      required: true,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    durationSeconds: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
    },
    openedReadingId: { type: String },
    closedReadingId: { type: String },
    durationUncertain: { type: Boolean, default: false },
  },
  {
    collection: "doorEvents",
  },
);
// ==========================================
// Models
// ==========================================
const SensorData = mongoose.model("SensorData", sensorDataSchema);
const Alert = mongoose.model("Alert", alertSchema);
const DoorEvent = mongoose.model("DoorEvent", doorEventSchema);
// ==========================================
// Alert Evaluation Logic
// ==========================================
async function checkAlerts(sensorData) {
  const { deviceId, temperature, humidity } = sensorData;
  const generatedAlerts = [];
  // ==========================================
  // Helper: Create alert only if not active
  // ==========================================
  async function createAlertIfNeeded(type, severity, message, value) {
    const existingAlert = await Alert.findOne({
      deviceId,
      type,
      resolved: false,
    });
    // An active alert already exists
    if (existingAlert) {
      return;
    }
    const newAlert = await Alert.create({
      deviceId,
      type,
      severity,
      message,
      value,
    });
    generatedAlerts.push(newAlert);
    console.log(`🚨 ${severity} | ${type} | ${message}`);
  }
  // ==========================================
  // Helper: Resolve active alert
  // ==========================================
  async function resolveAlert(type) {
    const activeAlert = await Alert.findOne({
      deviceId,
      type,
      resolved: false,
    });
    if (!activeAlert) {
      return;
    }
    activeAlert.resolved = true;
    activeAlert.resolvedAt = new Date();
    await activeAlert.save();
    console.log(`✅ RESOLVED | ${type}`);
  }
  // ==========================================
  // Temperature High
  // ==========================================
  if (temperature > TEMP_MAX) {
    await createAlertIfNeeded(
      "TEMPERATURE_HIGH",
      "CRITICAL",
      `Temperature exceeded maximum limit of ${TEMP_MAX}°C`,
      temperature,
    );
  } else {
    await resolveAlert("TEMPERATURE_HIGH");
  }
  // ==========================================
  // Temperature Low
  // ==========================================
  if (temperature < TEMP_MIN) {
    await createAlertIfNeeded(
      "TEMPERATURE_LOW",
      "WARNING",
      `Temperature dropped below minimum limit of ${TEMP_MIN}°C`,
      temperature,
    );
  } else {
    await resolveAlert("TEMPERATURE_LOW");
  }
  // ==========================================
  // Humidity High
  // ==========================================
  if (humidity > HUMIDITY_MAX) {
    await createAlertIfNeeded(
      "HUMIDITY_HIGH",
      "WARNING",
      `Humidity exceeded maximum limit of ${HUMIDITY_MAX}%`,
      humidity,
    );
  } else {
    await resolveAlert("HUMIDITY_HIGH");
  }
  // ==========================================
  // Humidity Low
  // ==========================================
  if (humidity < HUMIDITY_MIN) {
    await createAlertIfNeeded(
      "HUMIDITY_LOW",
      "WARNING",
      `Humidity dropped below minimum limit of ${HUMIDITY_MIN}%`,
      humidity,
    );
  } else {
    await resolveAlert("HUMIDITY_LOW");
  }
  return generatedAlerts;
}
// ==========================================
// Door Duration Tracking
// ==========================================
async function handleDoorState(sensorData, allowAlerts = true) {
  const { deviceId, doorOpen, timestamp, capturedAt, readingId } = sensorData;
  const now = capturedAt || timestamp || new Date();
  // Find currently active door-opening event
  let activeDoorEvent = await DoorEvent.findOne({
    deviceId,
    status: "OPEN",
  }).sort({
    openedAt: -1,
  });
  if (activeDoorEvent && now.getTime() < activeDoorEvent.openedAt.getTime()) {
    // A delayed upload must never close a newer door event at an earlier time.
    return {
      doorOpen,
      durationSeconds: 0,
      alertCreated: false,
      alertEscalated: false,
    };
  }
  if (activeDoorEvent?.durationUncertain) {
    // An unknown-clock gap could contain door transitions. End this segment
    // with unknown duration and anchor a new one at the first trusted sample.
    activeDoorEvent.closedAt = now;
    activeDoorEvent.durationSeconds = null;
    activeDoorEvent.status = "CLOSED";
    await activeDoorEvent.save();
    activeDoorEvent = null;
    if (allowAlerts) {
      const oldDoorAlert = await Alert.findOne({
        deviceId,
        type: "DOOR_OPEN_TOO_LONG",
        resolved: false,
      });
      if (oldDoorAlert) {
        oldDoorAlert.resolved = true;
        oldDoorAlert.resolvedAt = now;
        await oldDoorAlert.save();
        console.log("✅ RESOLVED | DOOR_OPEN_TOO_LONG | clock gap");
      }
    }
  }
  // ==========================================
  // DOOR IS OPEN
  // ==========================================
  if (doorOpen) {
    // ----------------------------------------
    // Door just opened
    // ----------------------------------------
    if (!activeDoorEvent) {
      activeDoorEvent = await DoorEvent.create({
        deviceId,
        openedAt: now,
        status: "OPEN",
        openedReadingId: readingId,
      });
      console.log("🚪 DOOR OPENED");
      return {
        doorOpen: true,
        durationSeconds: 0,
        alertCreated: false,
        alertEscalated: false,
      };
    }
    // ----------------------------------------
    // Calculate how long door has been open
    // ----------------------------------------
    const durationSeconds = Math.max(0, Math.floor(
      (now.getTime() - activeDoorEvent.openedAt.getTime()) / 1000,
    ));
    // Historical readings reconstruct events, but never change active alerts.
    if (!allowAlerts) {
      return {
        doorOpen: true,
        durationSeconds,
        alertCreated: false,
        alertEscalated: false,
      };
    }
    // Find existing active door alert
    let doorAlert = await Alert.findOne({
      deviceId,
      type: "DOOR_OPEN_TOO_LONG",
      resolved: false,
    });
    // ==========================================
    // CRITICAL
    // ==========================================
    if (durationSeconds >= DOOR_CRITICAL_SECONDS) {
      // No alert yet
      if (!doorAlert) {
        doorAlert = await Alert.create({
          deviceId,
          type: "DOOR_OPEN_TOO_LONG",
          severity: "CRITICAL",
          message: `Door has been open for ` + `${durationSeconds} seconds`,
          value: durationSeconds,
        });
        console.log(`🚨 CRITICAL | DOOR OPEN | ` + `${durationSeconds}s`);
        return {
          doorOpen: true,
          durationSeconds,
          alertCreated: true,
          alertEscalated: false,
        };
      }
      // Escalate WARNING → CRITICAL
      if (doorAlert.severity !== "CRITICAL") {
        doorAlert.severity = "CRITICAL";
        doorAlert.value = durationSeconds;
        doorAlert.message = `Door has been open for ${durationSeconds} seconds`;
        await doorAlert.save();
        console.log(
          `🚨 ESCALATED TO CRITICAL | DOOR OPEN | ${durationSeconds}s`,
        );
        return {
          doorOpen: true,
          durationSeconds,
          alertCreated: false,
          alertEscalated: true,
        };
      }
      // Update current duration
      doorAlert.value = durationSeconds;
      doorAlert.message = `Door has been open for ${durationSeconds} seconds`;
      await doorAlert.save();
      return {
        doorOpen: true,
        durationSeconds,
        alertCreated: false,
        alertEscalated: false,
      };
    }
    // ==========================================
    // WARNING
    // ==========================================
    if (durationSeconds >= DOOR_WARNING_SECONDS) {
      if (!doorAlert) {
        await Alert.create({
          deviceId,
          type: "DOOR_OPEN_TOO_LONG",
          severity: "WARNING",
          message: `Door has been open for ` + `${durationSeconds} seconds`,
          value: durationSeconds,
        });
        console.log(`⚠️ WARNING | DOOR OPEN | ` + `${durationSeconds}s`);
        return {
          doorOpen: true,
          durationSeconds,
          alertCreated: true,
          alertEscalated: false,
        };
      }
      // Update duration without creating duplicate
      doorAlert.value = durationSeconds;
      doorAlert.message = `Door has been open for ${durationSeconds} seconds`;
      await doorAlert.save();
    }
    return {
      doorOpen: true,
      durationSeconds,
      alertCreated: false,
      alertEscalated: false,
    };
  }
  // ==========================================
  // DOOR IS CLOSED
  // ==========================================
  if (activeDoorEvent) {
    const durationSeconds = Math.max(0, Math.floor(
      (now.getTime() - activeDoorEvent.openedAt.getTime()) / 1000,
    ));
    activeDoorEvent.closedAt = now;
    activeDoorEvent.durationSeconds = durationSeconds;
    activeDoorEvent.status = "CLOSED";
    activeDoorEvent.closedReadingId = readingId;
    await activeDoorEvent.save();
    console.log(`🚪 DOOR CLOSED | ` + `Open duration: ${durationSeconds}s`);
  }
  // A retry after a lost response can reach this branch after the close saved.
  let recentlyClosedEvent = null;
  if (!activeDoorEvent && readingId) {
    recentlyClosedEvent = await DoorEvent.findOne({ deviceId, closedReadingId: readingId });
  }
  // ------------------------------------------
  // Resolve any active door alert
  // ------------------------------------------
  if (allowAlerts) {
    const doorAlert = await Alert.findOne({
      deviceId,
      type: "DOOR_OPEN_TOO_LONG",
      resolved: false,
    });
    if (doorAlert) {
      doorAlert.resolved = true;
      doorAlert.resolvedAt = now;
      await doorAlert.save();
      console.log("✅ RESOLVED | DOOR_OPEN_TOO_LONG");
    }
  }
  return {
    doorOpen: false,
    durationSeconds: activeDoorEvent
      ? activeDoorEvent.durationSeconds
      : recentlyClosedEvent?.durationSeconds || 0,
    alertCreated: false,
    alertEscalated: false,
  };
}
// ==========================================
// Environmental Storage Risk Engine
// ==========================================
function calculateRisk(sensorData, doorStatus) {
  const { temperature, humidity, doorOpen } = sensorData;
  const doorDuration = doorStatus.durationSeconds || 0;
  let score = 0;
  const reasons = [];
  // ==========================================
  // 1. Temperature Risk
  // Maximum: 55 points
  // ==========================================
  let temperatureDeviation = 0;
  if (temperature > TEMP_MAX) {
    temperatureDeviation = temperature - TEMP_MAX;
  } else if (temperature < TEMP_MIN) {
    temperatureDeviation = TEMP_MIN - temperature;
  }
  if (temperatureDeviation > 0) {
    if (temperatureDeviation <= 2) {
      score += 20;
      reasons.push("Temperature is slightly outside the safe range");
    } else if (temperatureDeviation <= 5) {
      score += 35;
      reasons.push("Temperature is significantly outside the safe range");
    } else {
      score += 55;
      reasons.push("Temperature is far outside the safe range");
    }
  }
  // ==========================================
  // 2. Humidity Risk
  // Maximum: 20 points
  // ==========================================
  let humidityDeviation = 0;
  if (humidity > HUMIDITY_MAX) {
    humidityDeviation = humidity - HUMIDITY_MAX;
  } else if (humidity < HUMIDITY_MIN) {
    humidityDeviation = HUMIDITY_MIN - humidity;
  }
  if (humidityDeviation > 0) {
    if (humidityDeviation <= 10) {
      score += 8;
      reasons.push("Humidity is slightly outside the safe range");
    } else if (humidityDeviation <= 20) {
      score += 14;
      reasons.push("Humidity is significantly outside the safe range");
    } else {
      score += 20;
      reasons.push("Humidity is far outside the safe range");
    }
  }
  // ==========================================
  // 3. Door Exposure Risk
  // Maximum: 25 points
  // ==========================================
  if (doorOpen) {
    if (doorDuration < DOOR_WARNING_SECONDS) {
      score += 5;
      reasons.push("Storage door is currently open");
    } else if (doorDuration < DOOR_CRITICAL_SECONDS) {
      score += 15;
      reasons.push(`Door has remained open for ${doorDuration} seconds`);
    } else {
      score += 25;
      reasons.push(
        `Door has remained open for a critical duration of ${doorDuration} seconds`,
      );
    }
  }
  // ==========================================
  // Ensure score never exceeds 100
  // ==========================================
  score = Math.min(score, 100);
  // ==========================================
  // Determine Risk Level
  // ==========================================
  let level = "LOW";
  if (score >= 75) {
    level = "CRITICAL";
  } else if (score >= 50) {
    level = "HIGH";
  } else if (score >= 25) {
    level = "MEDIUM";
  }
  // No abnormal conditions
  if (reasons.length === 0) {
    reasons.push("All monitored conditions are within configured limits");
  }
  return {
    score,
    level,
    reasons,
  };
}
// ==========================================
// Phase 21: Validate Capture Time and Stable ID
// ==========================================
function parseReading(body, receivedAt, queueRetry = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON object required");
  }
  const { temperature, humidity, doorOpen } = body;
  if (temperature === undefined || humidity === undefined || doorOpen === undefined) {
    throw new Error("Missing sensor data");
  }
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) ||
      typeof doorOpen !== "boolean") {
    throw new Error("Invalid sensor data types");
  }
  if (humidity < 0 || humidity > 100) {
    throw new Error("Humidity must be between 0 and 100");
  }

  // Older firmware has no readingId. It retains the old live POST behavior.
  const legacy = body.readingId === undefined;
  const deviceId = legacy ? "cold-storage-01" : body.deviceId;
  const readingId = legacy
    ? `legacy-${new mongoose.Types.ObjectId()}`
    : body.readingId;
  if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) ||
      typeof readingId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(readingId)) {
    throw new Error("Invalid deviceId or readingId");
  }

  if (!legacy && typeof body.historical !== "boolean") {
    throw new Error("historical must be boolean");
  }
  const timeQuality = legacy ? "legacy" : body.timeQuality;
  if (!legacy && !["ntp", "unknown"].includes(timeQuality)) {
    throw new Error("Invalid timeQuality");
  }
  let capturedAt = null;
  if (legacy) {
    capturedAt = receivedAt;
  } else if (timeQuality === "ntp") {
    if (typeof body.capturedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(body.capturedAt)) {
      throw new Error("capturedAt must be an ISO UTC timestamp");
    }
    capturedAt = new Date(body.capturedAt);
    if (Number.isNaN(capturedAt.getTime()) ||
        capturedAt.getUTCFullYear() < 2020 ||
        capturedAt.getTime() > receivedAt.getTime() + 5000) {
      throw new Error("capturedAt is outside the valid clock range");
    }
  } else if (body.capturedAt != null) {
    throw new Error("Unknown clock time must have null capturedAt");
  }

  const historical = legacy ? false : (body.historical || queueRetry);
  const ageMs = capturedAt ? receivedAt.getTime() - capturedAt.getTime() : Infinity;
  // A queued replay must not replace the current state or affect active alerts.
  const liveEligible = legacy || (timeQuality === "ntp" && !historical &&
    ageMs >= -5000 && ageMs <= 10000);
  return {
    deviceId, readingId, temperature, humidity, doorOpen,
    capturedAt, receivedAt, timestamp: capturedAt || receivedAt,
    timeQuality, historical, liveEligible,
  };
}

function samePayload(saved, incoming) {
  return saved.temperature === incoming.temperature &&
    saved.humidity === incoming.humidity &&
    saved.doorOpen === incoming.doorOpen &&
    saved.timeQuality === incoming.timeQuality &&
    // Retry transport metadata may turn a previously unprocessed sample into
    // history-only; it is not part of the captured measurement's identity.
    (saved.capturedAt?.getTime() || null) ===
      (incoming.capturedAt?.getTime() || null);
}

function readingFollows(openedReadingId, readingId) {
  // Phase-21 firmware IDs contain a chip, optional per-boot nonce, boot
  // counter, and reading counter. The optional form supports earlier builds.
  // Unknown capture times can be ordered only within that device sequence.
  const pattern = /^esp([0-9a-fA-F]{6})(?:-n([0-9a-fA-F]{16}))?-b(\d{10})-r(\d{6})$/;
  const opened = typeof openedReadingId === "string"
    ? pattern.exec(openedReadingId) : null;
  const current = typeof readingId === "string"
    ? pattern.exec(readingId) : null;
  if (!opened || !current || opened[1].toLowerCase() !== current[1].toLowerCase()) {
    return false;
  }
  const openedBoot = Number(opened[3]);
  const currentBoot = Number(current[3]);
  if (currentBoot !== openedBoot) return currentBoot > openedBoot;
  // A reset boot counter after a deliberate filesystem format may reuse its
  // number; differing nonces make same-boot ordering unsafe.
  if ((opened[2] || "").toLowerCase() !== (current[2] || "").toLowerCase()) {
    return false;
  }
  return Number(current[4]) > Number(opened[4]);
}

function responseDoor(reading) {
  const status = reading.doorStatus || {};
  return {
    open: reading.doorOpen,
    durationSeconds: status.durationSeconds || 0,
    alertCreated: Boolean(status.alertCreated),
    alertEscalated: Boolean(status.alertEscalated),
  };
}

function responseRisk(reading) {
  return {
    score: reading.riskScore,
    level: reading.riskLevel,
    reasons: reading.riskReasons,
  };
}

// A capture-time-ordered reading may extend door history. Only a fresh reading
// with historical=false may evaluate or resolve active alerts.
async function processReading(reading, token, forceHistorical = false) {
  let newerReading = false;
  if (reading.capturedAt) {
    newerReading = Boolean(await SensorData.exists({
      deviceId: reading.deviceId,
      processingComplete: true,
      // Unknown-time rows use receipt time as their display timestamp; they
      // cannot establish capture chronology.
      capturedAt: { $gt: reading.capturedAt },
    }));
    if (!newerReading) {
      // Pre-Phase-21 rows had neither readingId nor capturedAt.
      newerReading = Boolean(await SensorData.exists({
        deviceId: reading.deviceId,
        readingId: { $exists: false },
        timestamp: { $gt: reading.timestamp },
      }));
    }
  }
  const chronological = Boolean(reading.capturedAt && !newerReading);
  const ageMs = reading.capturedAt
    ? Date.now() - reading.capturedAt.getTime()
    : Infinity;
  const live = chronological && !forceHistorical && reading.liveEligible &&
    ageMs >= -5000 && ageMs <= 10000;
  if (!reading.capturedAt) {
    const openEvent = await DoorEvent.findOne({
      deviceId: reading.deviceId,
      status: "OPEN",
    }).sort({ openedAt: -1 });
    if (openEvent && !openEvent.durationUncertain &&
        readingFollows(openEvent.openedReadingId, reading.readingId)) {
      openEvent.durationUncertain = true;
      await openEvent.save();
    }
  }
  const generatedAlerts = live ? await checkAlerts(reading) : [];
  const doorStatus = chronological
    ? await handleDoorState(reading, live)
    : {
        doorOpen: reading.doorOpen,
        durationSeconds: 0,
        alertCreated: false,
        alertEscalated: false,
      };
  const risk = calculateRisk(reading, doorStatus);
  const totalAlertsGenerated =
    generatedAlerts.length + (doorStatus.alertCreated ? 1 : 0);

  const completed = await SensorData.updateOne({
    _id: reading._id,
    processingToken: token,
  }, {
    $set: {
      riskScore: risk.score,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      liveEligible: live,
      historical: reading.historical || forceHistorical,
      doorStatus,
      alertsGenerated: totalAlertsGenerated,
      processingComplete: true,
    },
    $unset: { processingToken: "", processingLeaseUntil: "" },
  });
  if (completed.modifiedCount !== 1) {
    throw new Error("Processing claim was lost");
  }
  return { doorStatus, risk, totalAlertsGenerated, live };
}
// ==========================================
// Health Check Route
// ==========================================
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "ESP8266 Cold Storage API is running",
  });
});
// ==========================================
// Sensor Data Ingestion API
// POST /api/sensor-data
// Used by ESP8266
// ==========================================
app.post("/api/sensor-data", async (req, res) => {
  if (process.env.DEVICE_API_KEY &&
      !matchesSecret(req.get?.("X-Device-Key"), process.env.DEVICE_API_KEY)) {
    return res.status(401).json({ success: false, message: "Invalid device key" });
  }
  const receivedAt = new Date();
  const queueRetry = req.get?.("X-Queue-Retry") === "true";
  let incoming;
  try {
    incoming = parseReading(
      req.body,
      receivedAt,
      queueRetry,
    );
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (process.env.DEVICE_ID && incoming.deviceId !== process.env.DEVICE_ID) {
    return res.status(403).json({ success: false, message: "Device not allowed" });
  }

  try {
    const key = {
      deviceId: incoming.deviceId,
      readingId: incoming.readingId,
    };
    // MongoDB's unique index makes a lost HTTP ACK safe to retry.
    let insertResult;
    try {
      insertResult = await SensorData.updateOne(
        key,
        { $setOnInsert: incoming },
        { upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      insertResult = { upsertedCount: 0 };
    }
    let savedData = await SensorData.findOne(key);
    if (!savedData) throw new Error("Reading disappeared after write");
    if (!samePayload(savedData, incoming)) {
      return res.status(409).json({
        success: false,
        message: "readingId already used for different data",
      });
    }

    let processed = null;
    if (!savedData.processingComplete) {
      const token = randomUUID();
      const claim = await SensorData.findOneAndUpdate({
        _id: savedData._id,
        processingComplete: false,
        $or: [
          { processingLeaseUntil: { $exists: false } },
          { processingLeaseUntil: { $lte: new Date() } },
        ],
      }, {
        $set: {
          processingToken: token,
          processingLeaseUntil: new Date(Date.now() + 60000),
        },
      }, { returnDocument: "after" });
      if (!claim) {
        savedData = await SensorData.findById(savedData._id);
        if (!savedData?.processingComplete) {
          return res.status(503).json({
            success: false,
            message: "Reading is being processed; retry",
          });
        }
      } else {
        try {
          processed = await processReading(claim, token, queueRetry);
        } catch (error) {
          await SensorData.updateOne({ _id: savedData._id, processingToken: token }, {
            $unset: { processingToken: "", processingLeaseUntil: "" },
          });
          throw error;
        }
      }
    }

    const door = processed ? {
      open: incoming.doorOpen,
      durationSeconds: processed.doorStatus.durationSeconds,
      alertCreated: processed.doorStatus.alertCreated,
      alertEscalated: processed.doorStatus.alertEscalated,
    } : responseDoor(savedData);
    const risk = processed?.risk || responseRisk(savedData);
    const alertsGenerated = processed?.totalAlertsGenerated ?? savedData.alertsGenerated;

    if (insertResult.upsertedCount) {
      console.log("\n=============================");
      console.log("📥 NEW SENSOR DATA RECEIVED");
      console.log("Temperature :", incoming.temperature, "°C");
      console.log("Humidity    :", incoming.humidity, "%");
      console.log("Door        :", incoming.doorOpen ? "OPEN 🚨" : "CLOSED ✅");
      console.log("Door Time   :", door.durationSeconds, "seconds");
      console.log("Saved ID    :", savedData._id);
      console.log("Reading ID  :", savedData.readingId);
      console.log("Alerts      :", alertsGenerated);
      console.log("Door Alert  :", door.alertCreated ? "CREATED" :
        door.alertEscalated ? "ESCALATED" : "NONE");
      console.log("Risk Score  :", `${risk.score}/100`);
      console.log("Risk Level  :", risk.level);
      console.log("Risk Reasons:", risk.reasons.join(" | "));
      console.log("Delivery    :", processed?.live ? "LIVE" : "HISTORICAL / NOT LIVE");
      console.log("Captured IST:", logTimeIST(savedData.capturedAt));
      console.log("Received IST:", logTimeIST(savedData.receivedAt));
      console.log("=============================");
    }

    // The firmware deletes a queued file only after this matching positive ACK.
    return res.status(insertResult.upsertedCount ? 201 : 200).json({
      success: true,
      message: "Sensor data saved",
      ack: {
        deviceId: savedData.deviceId,
        readingId: savedData.readingId,
        stored: true,
      },
      duplicate: !insertResult.upsertedCount,
      id: savedData._id,
      alertsGenerated,
      door,
      risk,
    });
  } catch (error) {
    console.error("❌ Error saving sensor data:", error.message);
    if (error.code === 8000 || /over your space quota|storage quota|quota exceeded/i.test(error.message)) {
      void trimOldestReadings();
      return res.status(503).json({ success: false, message: "Database storage full; retry after oldest readings are removed" });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to persist/process reading",
    });
  }
});
// ==========================================
// Latest Sensor Reading API
// GET /api/sensor-data/latest
// ==========================================
const currentFilter = {
  $or: [
    { liveEligible: true, processingComplete: true },
    // Keep pre-Phase-21 documents visible until replaced by a newer live read.
    { liveEligible: { $exists: false } },
  ],
};
const trimOldestReadings = createStorageMaintainer({
  connection: mongoose.connection,
  SensorData,
  Alert,
  DoorEvent,
  latestFilter: currentFilter,
  highMiB: STORAGE_HIGH_WATER_MIB,
  lowMiB: STORAGE_LOW_WATER_MIB,
});

app.get("/api/sensor-data/latest", async (req, res) => {
  try {
    const latestReading = await SensorData.findOne(currentFilter).sort({ timestamp: -1 });
    if (!latestReading) {
      return res.status(404).json({
        success: false,
        message: "No sensor data found",
      });
    }
    res.json({
      success: true,
      data: latestReading,
      stale: Date.now() - latestReading.timestamp.getTime() > 30000,
    });
  } catch (error) {
    console.error("❌ Error fetching latest reading:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch latest sensor data",
    });
  }
});
// ==========================================
// Sensor History API
// GET /api/sensor-data/history
// Example:
// /api/sensor-data/history?limit=50
// ==========================================
app.get("/api/sensor-data/history", async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10) || 100;
    // Prevent invalid limits
    if (limit < 1) {
      limit = 100;
    }
    if (limit > 1000) {
      limit = 1000;
    }
    // Get newest records first
    const readings = await SensorData.find({
      $or: [
        { processingComplete: true },
        { processingComplete: { $exists: false } },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    // Reverse for graph-friendly chronological order
    readings.reverse();
    res.json({
      success: true,
      count: readings.length,
      data: readings,
    });
  } catch (error) {
    console.error("❌ Error fetching sensor history:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch sensor history",
    });
  }
});
// ==========================================
// Alert Read API
// GET /api/alerts
// GET /api/alerts?active=true
// ==========================================
app.get("/api/alerts", async (req, res) => {
  try {
    const filter = {};
    if (req.query.active === "true") {
      filter.resolved = false;
    }
    const alerts = await Alert.find(filter).sort({ timestamp: -1 }).limit(100);
    res.json({
      success: true,
      count: alerts.length,
      data: alerts,
    });
  } catch (error) {
    console.error("❌ Error fetching alerts:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch alerts",
    });
  }
});
// ==========================================
// Door Event History API
// GET /api/door-events
// ==========================================
app.get("/api/door-events", async (req, res) => {
  try {
    const events = await DoorEvent.find().sort({ openedAt: -1 }).limit(100);
    res.json({
      success: true,
      count: events.length,
      data: events,
    });
  } catch (error) {
    console.error("❌ Error fetching door events:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch door events",
    });
  }
});
// ==========================================
// Current Storage Risk API
// GET /api/risk/current
// ==========================================
app.get("/api/risk/current", async (req, res) => {
  try {
    const latestReading = await SensorData.findOne(currentFilter).sort({
      timestamp: -1,
    });
    if (!latestReading) {
      return res.status(404).json({
        success: false,
        message: "No sensor data found",
      });
    }
    res.json({
      success: true,
      stale: Date.now() - latestReading.timestamp.getTime() > 30000,
      risk: {
        score: latestReading.riskScore,
        level: latestReading.riskLevel,
        reasons: latestReading.riskReasons,
      },
      sensorData: {
        temperature: latestReading.temperature,
        humidity: latestReading.humidity,
        doorOpen: latestReading.doorOpen,
        timestamp: latestReading.timestamp,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching current risk:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch current risk",
    });
  }
});
// ==========================================
// Start Server
// ==========================================
async function startServer() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DEVICE_API_KEY || process.env.DEVICE_API_KEY.length < 32) {
      throw new Error("DEVICE_API_KEY must contain at least 32 characters in production");
    }
    if (!process.env.CORS_ORIGIN) {
      throw new Error("CORS_ORIGIN is required in production");
    }
  }
  await connectDatabase();
  // Do not accept a reading until the unique readingId index is ready.
  await SensorData.init();
  // Clean proactively; waiting for Atlas's hard quota would reject uploads.
  void trimOldestReadings();
  const storageTimer = setInterval(trimOldestReadings, 30000);
  storageTimer.unref();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log("\n📊 Alert Thresholds");
    console.log("-----------------------------");
    console.log(`Temperature : ${TEMP_MIN}°C - ${TEMP_MAX}°C`);
    console.log(`Humidity    : ${HUMIDITY_MIN}% - ${HUMIDITY_MAX}%`);
    console.log(`Door Warning  : ${DOOR_WARNING_SECONDS}s`);
    console.log(`Door Critical : ${DOOR_CRITICAL_SECONDS}s`);
    console.log("-----------------------------\n");
  });
}
if (require.main === module) {
  startServer().catch((error) => {
    console.error("❌ Server startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  parseReading,
  calculateRisk,
  processReading,
  models: { SensorData, Alert, DoorEvent },
};
