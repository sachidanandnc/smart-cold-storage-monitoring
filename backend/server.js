const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 5000;

// ==========================================
// Middleware
// ==========================================

app.use(cors());
app.use(express.json());

// ==========================================
// MongoDB Connection
// ==========================================

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
  })
  .catch((error) => {
    console.error("❌ MongoDB connection failed:");
    console.error(error.message);
  });

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
// Model
// ==========================================

const SensorData = mongoose.model("SensorData", sensorDataSchema);

// ==========================================
// Test Route
// ==========================================

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "ESP8266 Cold Storage API is running",
  });
});

// ==========================================
// Receive Sensor Data
// ==========================================

app.post("/api/sensor-data", async (req, res) => {
  try {
    const { temperature, humidity, doorOpen } = req.body;

    // ------------------------------
    // Basic validation
    // ------------------------------

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

    // ------------------------------
    // Create database record
    // ------------------------------

    const sensorReading = new SensorData({
      temperature: temperature,

      humidity: humidity,

      doorOpen: doorOpen,

      deviceId: "cold-storage-01",
    });

    // ------------------------------
    // Save to MongoDB
    // ------------------------------

    const savedData = await sensorReading.save();

    // ------------------------------
    // Console output
    // ------------------------------

    console.log("\n=============================");
    console.log("📥 NEW SENSOR DATA RECEIVED");

    console.log("Temperature :", temperature, "°C");

    console.log("Humidity    :", humidity, "%");

    console.log("Door        :", doorOpen ? "OPEN 🚨" : "CLOSED ✅");

    console.log("Saved ID    :", savedData._id);

    console.log("Timestamp   :", savedData.timestamp.toLocaleString());

    console.log("=============================");

    // ------------------------------
    // Response to ESP8266
    // ------------------------------

    res.json({
      success: true,

      message: "Sensor data saved",

      id: savedData._id,
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
// Start Server
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
