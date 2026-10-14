# ❄️ Smart Cold Storage Monitoring System

**An IoT-powered environmental monitoring and analytics platform built with ESP8266, React, Node.js, Express, and MongoDB Atlas.**

Smart Cold Storage Monitoring is a full-stack IoT solution designed to monitor temperature, humidity, and door activity in cold-storage environments. It combines embedded hardware, wireless communication, a RESTful backend, persistent data storage, automated alerts, environmental risk analysis, and a modern web dashboard.

The system helps operators identify unfavorable storage conditions, monitor environmental trends, and review historical events from a centralized interface.

**Project Status:** Core system operational | Offline synchronization under validation

## ✨ Key Features

### 🌡️ Real-Time Environmental Monitoring

- Temperature and relative humidity monitoring using a DHT22 sensor.
- Physical door-open/closed detection.
- ESP8266-based Wi-Fi communication.
- Automatic sensor updates approximately every 5 seconds.
- Local LCD1602 display for environmental readings, door status, and Wi-Fi information.
- Physical button for LCD screen navigation.

### 📊 Interactive Monitoring Dashboard

Built with React and Recharts, the dashboard provides:

- Live temperature and humidity readings.
- Door status and environmental risk indicators.
- Historical temperature, humidity, and risk graphs.
- Configurable historical reading window.
- Responsive interface for desktop and mobile devices.
- Connection and delayed-reading indicators.
- Manual refresh and automatic polling.

### 🚨 Automated Alert Management

The backend continuously evaluates incoming measurements against configurable environmental limits.

Supported alert conditions include:

- Temperature above the configured maximum.
- Temperature below the configured minimum.
- Humidity above the configured maximum.
- Humidity below the configured minimum.
- Storage door remaining open beyond a warning duration.
- Storage door remaining open beyond a critical duration.

Alerts support severity classification, duplicate prevention, automatic resolution, and persistent storage in MongoDB.

### 🛡️ Environmental Risk Assessment

The platform implements a transparent, rule-based environmental risk engine.

Risk is calculated from three factors:

| Risk Factor | Maximum Contribution |
|---|---:|
| Temperature deviation | 55 points |
| Humidity deviation | 20 points |
| Door-open duration | 25 points |
| **Total** | **100 points** |

The calculated score is classified into four levels:

| Score | Risk Classification |
|---|---|
| 0–24 | LOW |
| 25–49 | MEDIUM |
| 50–74 | HIGH |
| 75–100 | CRITICAL |

The dashboard displays both the risk score and the reasons contributing to the assessment.

**Note:** This score represents environmental exposure risk. It does not directly establish whether stored food, medicines, or other products have spoiled. Safe environmental limits must be configured for the specific stored product.

### 📈 Historical Analytics

The analytics module provides:

- Minimum, average, and maximum temperature.
- Minimum, average, and maximum humidity.
- Average and peak environmental risk.
- Distribution of LOW, MEDIUM, HIGH, and CRITICAL readings.
- Recorded door-opening events.
- Total and longest recorded door-open duration.
- Statistics based on the selected historical window.

These analytics help identify patterns and evaluate storage conditions over time.

## 🏗️ System Architecture

The system uses a layered IoT architecture.

```text
  ┌────────────────────────────────┐
  │        COLD STORAGE UNIT       │
  │                                │
  │   DHT22         Door Sensor    │
  │     │                │         │
  │     └──────┬─────────┘         │
  │            ▼                   │
  │      ESP8266 NodeMCU          │
  │            │                   │
  │       LCD1602 Display          │
  └────────────┼───────────────────┘
               │
               │ Wi-Fi / HTTP
               ▼
  ┌────────────────────────────────┐
  │       Node.js + Express        │
  │                                │
  │  REST API / Input Validation   │
  │  Alert & Door Event Tracking   │
  │  Environmental Risk Engine     │
  └────────────┬───────────────────┘
               │
               ▼
  ┌────────────────────────────────┐
  │          MongoDB Atlas         │
  │                                │
  │          sensorData            │
  │          alerts                │
  │          doorEvents            │
  └────────────┬───────────────────┘
               │
               │ REST API
               ▼
  ┌────────────────────────────────┐
  │       React + Recharts         │
  │                                │
  │    Live Monitoring Dashboard   │
  │    Historical Visualization    │
  │    Environmental Analytics     │
  └────────────────────────────────┘
```

The ESP8266 collects measurements and sends them to the Express backend. The backend validates and stores readings, maintains alerts and door events, and calculates environmental risk.

The React frontend retrieves this information through REST APIs and presents it in an interactive dashboard.

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| Microcontroller | ESP8266 NodeMCU |
| Environmental sensor | DHT22 |
| Door detection | Physical switch/input |
| Local display | LCD1602, 4-bit interface |
| Firmware | Arduino C/C++ |
| Communication | Wi-Fi, HTTP, JSON |
| Frontend | React.js, Vite |
| Charts | Recharts |
| Backend | Node.js, Express.js |
| Database | MongoDB Atlas |
| ODM | Mongoose |
| Version Control | Git, GitHub |

## 🔌 Hardware Components

| Component | Purpose |
|---|---|
| ESP8266 NodeMCU | Main IoT controller |
| DHT22 | Temperature and humidity sensing |
| Door sensor/switch | Door state detection |
| LCD1602 | Local monitoring |
| Push button | LCD page navigation |
| Resistors | Input biasing and electrical interfacing |
| Breadboard/jumper wires | Circuit connections |
| USB power source | Power and firmware programming |

### Pin Configuration

| Component | ESP8266 Connection |
|---|---|
| DHT22 DATA | D5 |
| Door Sensor | A0 |
| LCD RS | D1 |
| LCD Enable | D2 |
| LCD D4 | D4 |
| LCD D5 | D0 |
| LCD D6 | D6 |
| LCD D7 | D7 |
| LCD Navigation Button | D3 |

The LCD operates in 4-bit parallel mode using the Arduino LiquidCrystal library.

**Hardware notes:**

- DHT22 is powered from 3.3 V.
- A bare DHT22 typically requires a pull-up resistor on its DATA line.
- The A0 input voltage must remain within the supported range of the specific NodeMCU board.
- D3/GPIO0 is boot-sensitive and should not be held LOW during normal startup.
- LCD power, contrast, and backlight connections must be wired appropriately.

## 📁 Project Structure

```text
smart-cold-storage-monitoring/
│
├── esp8266/
│   └── firmware/
│       ├── firmware.ino
│       ├── wifi.h
│       └── wifi.example.h
│
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env
│   └── .env.example
│
├── dashboard/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── AnalyticsSection.jsx
│   │   ├── AnalyticsSection.css
│   │   └── main.jsx
│   │
│   └── package.json
│
├── docs/
│
├── .gitignore
└── README.md
```

Some generated files and additional frontend components may vary depending on the development version.

**Security:** `wifi.h` and `.env` contain local configuration or credentials and must not be committed to the repository.

## 🚀 Getting Started

### Prerequisites

Ensure the following are installed:

- Node.js and npm.
- Arduino IDE with ESP8266 board support.
- Git.
- A MongoDB Atlas account.
- A working ESP8266 NodeMCU and connected sensors.

The ESP8266 and backend machine should initially be connected to the same local network.

### 1. Clone the Repository

```bash
git clone https://github.com/sachidanandnc/smart-cold-storage-monitoring.git

cd smart-cold-storage-monitoring
```

### 2. Configure MongoDB Atlas

Create a MongoDB Atlas cluster and obtain its connection URI.

Configure database access and network permissions for your development environment.

The application uses the database:

`coldStorageDB`

Its primary collections are:

- `sensorData`
- `alerts`
- `doorEvents`

### 3. Configure the Backend

Navigate to the backend:

```bash
cd backend
npm install
```

Create a `.env` file based on `.env.example`.

Required configuration keys include:

```env
PORT=5000

MONGODB_URI=your_mongodb_connection_string

TEMP_MIN=your_minimum_temperature
TEMP_MAX=your_maximum_temperature

HUMIDITY_MIN=your_minimum_humidity
HUMIDITY_MAX=your_maximum_humidity

DOOR_WARNING_SECONDS=your_warning_duration
DOOR_CRITICAL_SECONDS=your_critical_duration
```

Replace the placeholders with values appropriate for your storage application.

The warning duration must be less than the critical duration, and minimum environmental thresholds must be lower than their maximum values.

Start the backend:

```bash
node server.js
```

The server listens on port `5000` by default.

Verify the health endpoint:

`http://localhost:5000/`

### 4. Configure ESP8266 Firmware

Open:

`esp8266/firmware/firmware.ino`

Install the necessary Arduino libraries, including:

- ESP8266WiFi
- ESP8266HTTPClient
- DHT sensor library
- Adafruit Unified Sensor
- LiquidCrystal

Create `wifi.h` from the provided example configuration.

Configure:

```cpp
#define MY_WIFI_SSID "YOUR_WIFI_NAME"
#define MY_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

#define SERVER_IP "192.168.1.10"
#define SERVER_PORT 5000
```

Replace `192.168.1.10` with the local IP address of the computer running the backend.

Upload the firmware to the ESP8266 using Arduino IDE.

Open Serial Monitor at:

`115200 baud`

Verify that sensor values are measured and transmitted to the backend.

### 5. Start the React Dashboard

Open another terminal:

```bash
cd dashboard
npm install
npm run dev
```

Open the Vite development URL, normally:

`http://localhost:5173`

The dashboard retrieves current and historical data from the backend on port `5000`.

## 🔗 REST API Reference

The Express backend exposes the following endpoints.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Server health check |
| POST | `/api/sensor-data` | Receive a sensor reading |
| GET | `/api/sensor-data/latest` | Retrieve latest reading |
| GET | `/api/sensor-data/history?limit=50` | Retrieve recent sensor history |
| GET | `/api/alerts` | Retrieve stored alerts |
| GET | `/api/alerts?active=true` | Retrieve unresolved alerts |
| GET | `/api/door-events` | Retrieve recorded door events |
| GET | `/api/risk/current` | Retrieve latest environmental risk |

### Example Sensor Payload

```json
{
  "temperature": 4.8,
  "humidity": 68.2,
  "doorOpen": false
}
```

The backend validates the incoming payload, saves the sensor data, evaluates environmental alerts, processes door-state information, and calculates a risk score.

### Example Current Risk Response

```json
{
  "success": true,
  "risk": {
    "score": 0,
    "level": "LOW",
    "reasons": [
      "All monitored conditions are within configured limits"
    ]
  },
  "sensorData": {
    "temperature": 4.8,
    "humidity": 68.2,
    "doorOpen": false,
    "timestamp": "2026-10-14T10:00:00.000Z"
  }
}
```

The values above are illustrative and depend on the configured thresholds.

## 🗄️ Database Design

### sensorData

Stores environmental measurements and their corresponding risk assessments.

Typical fields:

```text
deviceId
temperature
humidity
doorOpen
riskScore
riskLevel
riskReasons
timestamp
```

### alerts

Stores environmental and door-duration alerts.

Typical fields:

```text
deviceId
type
severity
message
value
resolved
resolvedAt
timestamp
```

### doorEvents

Tracks storage-door activity.

Typical fields:

```text
deviceId
openedAt
closedAt
durationSeconds
status
```

This separation allows the dashboard to retrieve historical readings, inspect alert events, and calculate door-activity statistics independently.

## 💾 Offline Data Handling — Phase 21

Offline data synchronization is being integrated and validated.

The intended mechanism uses the ESP8266's LittleFS flash storage to preserve measurements when the backend cannot be reached.

The workflow is:

```text
Capture sensor reading
        |
        v
Attempt backend delivery
        |
        +---- Success ----> Confirm delivery
        |
        +---- Failure ----> Save in LittleFS
                                  |
                                  v
                          Network restored
                                  |
                                  v
                          Replay queued data
                                  |
                                  v
                          Server acknowledgment
                                  |
                                  v
                          Remove delivered entry
```

The Phase 21 implementation also introduces the concept of stable reading identifiers and original measurement timestamps to support duplicate-safe synchronization.

This feature should be treated as **under validation** until offline capture, ESP8266 reboot, automatic replay, timestamp preservation, and duplicate prevention have been successfully tested together.

## 🧪 Testing and Validation

The monitoring platform can be validated through the following scenarios.

| Test | Expected Result |
|---|---|
| Normal sensor acquisition | Valid DHT22 readings |
| Door opened | Dashboard displays OPEN |
| Door closed | Dashboard displays CLOSED |
| Temperature threshold exceeded | Corresponding alert generated |
| Temperature returns to normal | Active alert resolved |
| Door remains open | Warning and critical escalation |
| Repeated abnormal readings | No unnecessary duplicate active alerts |
| Sensor data received | Reading stored in MongoDB |
| History API requested | Chronological sensor records returned |
| Dashboard running | Live data and charts update |
| Backend unavailable | Dashboard reports connection problem |
| Offline buffering (Phase 21) | Failed readings retained for replay |
| Offline synchronization (Phase 21) | Backlogged readings uploaded without duplicates |

Tests involving power failures, prolonged outages, clock synchronization, and flash capacity require additional end-to-end validation.

## 📸 Project Demonstration

Add real project screenshots and photographs to the `docs/screenshots/` directory.

Suggested screenshots:

| Screenshot | Description |
|---|---|
| Dashboard Overview | Live temperature, humidity, door and risk cards |
| Historical Monitoring | Temperature, humidity and risk graphs |
| Storage Analytics | Summary statistics and risk distribution |
| LCD Display | Physical device displaying live readings |
| Hardware Setup | ESP8266 and connected components |
| MongoDB Atlas | Stored sensor records and door events |

Real screenshots should be used rather than simulated output when presenting the project.

## 📍 Development Status

| Module | Status |
|---|---|
| ESP8266 + DHT22 integration | ✅ Completed |
| Physical door monitoring | ✅ Completed |
| LCD1602 display and navigation | ✅ Completed |
| Wi-Fi and HTTP communication | ✅ Completed |
| Node.js / Express backend | ✅ Completed |
| MongoDB Atlas persistence | ✅ Completed |
| Environmental alerts | ✅ Completed |
| Door-duration monitoring | ✅ Completed |
| Environmental risk engine | ✅ Completed |
| React monitoring dashboard | ✅ Completed |
| Historical charts | ✅ Completed |
| Environmental analytics | ✅ Completed |
| Offline data synchronization | 🔄 Under validation |
| Socket.IO real-time updates | Planned |
| Alerts dashboard interface | Planned |
| Cloud deployment | Planned |
| Multi-device support | Planned |
| Notifications | Planned |

## 🔮 Future Enhancements

Potential extensions include:

- Socket.IO or MQTT for event-driven communication.
- Multi-device monitoring and fleet management.
- Telegram, email, or push notifications.
- Cloud-hosted backend and frontend.
- Device authentication and secure communication.
- Database indexing and historical data retention policies.
- Enhanced offline synchronization and power-failure recovery.
- More accurate temperature sensing where required.
- Predictive maintenance for refrigeration equipment.
- Machine learning for environmental anomaly forecasting.
- Exportable reports and operational analytics.

## ⚠️ Current Limitations

The current system is a prototype intended for IoT monitoring, educational demonstration, and further development.

- Storage limits must be configured for the actual stored product.
- The risk engine is rule-based, not a validated product-spoilage prediction model.
- The DHT22 has measurement limitations and may not be suitable for every cold-storage environment.
- The local HTTP architecture is intended for development within a trusted network.
- Production deployment requires authentication, HTTPS, access control, and additional security measures.
- Offline synchronization requires hardware validation before being considered reliable.
- Device failure and power interruption can still affect measurement continuity.

The system is not certified for safety-critical or regulated pharmaceutical or food-storage operations.

## 👨‍💻 Author

**Sachidanand N C**

Computer Science and Engineering  
RV Institute of Technology and Management  
Bengaluru, Karnataka, India

GitHub: [@sachidanandnc](https://github.com/sachidanandnc)

## 📄 License

No license is specified in this README. Add a `LICENSE` file if you intend to distribute the project under an open-source license.

---

**Smart Cold Storage Monitoring — Combining embedded IoT, full-stack development, persistent data management, and environmental analytics in a unified monitoring platform.**
