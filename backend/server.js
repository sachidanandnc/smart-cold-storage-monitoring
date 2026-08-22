// ==========================================
// Imports
// ==========================================

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

// ==========================================
// Application Configuration
// ==========================================

const app = express();

// ==========================================
// Middleware
// ==========================================

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ==========================================
// Environment Variables / Thresholds
// ==========================================

const TEMP_MIN = Number(process.env.TEMP_MIN);
const TEMP_MAX = Number(process.env.TEMP_MAX);

const HUMIDITY_MIN = Number(process.env.HUMIDITY_MIN);
const HUMIDITY_MAX = Number(process.env.HUMIDITY_MAX);

const DOOR_WARNING_SECONDS = Number(process.env.DOOR_WARNING_SECONDS);

const DOOR_CRITICAL_SECONDS = Number(process.env.DOOR_CRITICAL_SECONDS);

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
  },
  {
    collection: "sensorData",
  },
);

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

async function handleDoorState(sensorData) {
  const { deviceId, doorOpen, timestamp } = sensorData;

  const now = timestamp || new Date();

  // Find currently active door-opening event
  let activeDoorEvent = await DoorEvent.findOne({
    deviceId,
    status: "OPEN",
  }).sort({
    openedAt: -1,
  });

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

    const durationSeconds = Math.floor(
      (now.getTime() - activeDoorEvent.openedAt.getTime()) / 1000,
    );

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
    const durationSeconds = Math.floor(
      (now.getTime() - activeDoorEvent.openedAt.getTime()) / 1000,
    );

    activeDoorEvent.closedAt = now;

    activeDoorEvent.durationSeconds = durationSeconds;

    activeDoorEvent.status = "CLOSED";

    await activeDoorEvent.save();

    console.log(`🚪 DOOR CLOSED | ` + `Open duration: ${durationSeconds}s`);
  }

  // ------------------------------------------
  // Resolve any active door alert
  // ------------------------------------------

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

  return {
    doorOpen: false,

    durationSeconds: activeDoorEvent ? activeDoorEvent.durationSeconds : 0,

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
  try {
    const { temperature, humidity, doorOpen } = req.body;

    // ------------------------------------------
    // Basic Validation
    // ------------------------------------------

    if (
      temperature === undefined ||
      humidity === undefined ||
      doorOpen === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing sensor data",
      });
    }

    // ------------------------------------------
    // Additional Type Validation
    // ------------------------------------------

    if (
      typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      typeof humidity !== "number" ||
      !Number.isFinite(humidity) ||
      typeof doorOpen !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid sensor data types",
      });
    }
    if (humidity < 0 || humidity > 100) {
      return res.status(400).json({
        success: false,
        message: "Humidity must be between 0 and 100",
      });
    }

    // ------------------------------------------
    // Create Sensor Reading
    // ------------------------------------------

    const sensorReading = new SensorData({
      temperature,
      humidity,
      doorOpen,
      deviceId: "cold-storage-01",
    });

    // ------------------------------------------
    // Save Sensor Reading to MongoDB
    // ------------------------------------------

    const savedData = await sensorReading.save();

    // ------------------------------------------
    // Evaluate Alerts
    // ------------------------------------------

    const generatedAlerts = await checkAlerts(savedData);

    // ------------------------------------------
    // Evaluate Door Status
    // ------------------------------------------

    const doorStatus = await handleDoorState(savedData);

    // ------------------------------------------
    // Evaluate Risk Status
    // ------------------------------------------

    const risk = calculateRisk(savedData, doorStatus);

    // Save calculated risk with sensor reading

    savedData.riskScore = risk.score;

    savedData.riskLevel = risk.level;

    savedData.riskReasons = risk.reasons;

    await savedData.save();

    // ------------------------------------------
    // Calculate Number of Newly Generated Alerts
    // ------------------------------------------

    const totalAlertsGenerated =
      generatedAlerts.length + (doorStatus.alertCreated ? 1 : 0);

    // ------------------------------------------
    // Console Logging
    // ------------------------------------------

    console.log("\n=============================");
    console.log("📥 NEW SENSOR DATA RECEIVED");

    console.log("Temperature :", temperature, "°C");
    console.log("Humidity    :", humidity, "%");

    console.log("Door        :", doorOpen ? "OPEN 🚨" : "CLOSED ✅");

    console.log("Door Time   :", doorStatus.durationSeconds, "seconds");

    console.log("Saved ID    :", savedData._id);

    console.log("Alerts      :", totalAlertsGenerated);

    console.log(
      "Door Alert  :",
      doorStatus.alertCreated
        ? "CREATED"
        : doorStatus.alertEscalated
          ? "ESCALATED"
          : "NONE",
    );

    console.log("Risk Score  :", `${risk.score}/100`);

    console.log("Risk Level  :", risk.level);

    console.log("Risk Reasons:", risk.reasons.join(" | "));

    console.log("Timestamp   :", savedData.timestamp.toLocaleString());

    console.log("=============================");

    // ------------------------------------------
    // Response to ESP8266
    // ------------------------------------------

    res.status(201).json({
      success: true,

      message: "Sensor data saved",

      id: savedData._id,

      alertsGenerated: totalAlertsGenerated,

      door: {
        open: doorOpen,

        durationSeconds: doorStatus.durationSeconds,

        alertCreated: doorStatus.alertCreated,

        alertEscalated: doorStatus.alertEscalated,
      },

      risk: {
        score: risk.score,

        level: risk.level,

        reasons: risk.reasons,
      },
    });
  } catch (error) {
    console.error("❌ Error saving sensor data:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to save sensor data",
    });
  }
});

// ==========================================
// Latest Sensor Reading API
// GET /api/sensor-data/latest
// ==========================================

app.get("/api/sensor-data/latest", async (req, res) => {
  try {
    const latestReading = await SensorData.findOne().sort({ timestamp: -1 });

    if (!latestReading) {
      return res.status(404).json({
        success: false,
        message: "No sensor data found",
      });
    }

    res.json({
      success: true,
      data: latestReading,
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
    const readings = await SensorData.find()
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
    const latestReading = await SensorData.findOne().sort({
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
  await connectDatabase();

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

startServer();
