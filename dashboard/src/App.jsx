import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // ==========================================
  // Fetch latest cold-storage status
  // ==========================================

  const fetchCurrentStatus = async () => {
    try {
      const response = await fetch(
        "http://localhost:5000/api/risk/current"
      );

      if (!response.ok) {
        throw new Error("Failed to fetch sensor data");
      }

      const result = await response.json();

      setData(result);
      setError("");
    } catch (err) {
      console.error("Dashboard fetch error:", err);

      setError(
        "Unable to connect to the cold-storage backend."
      );
    } finally {
      setLoading(false);
    }
  };

  // ==========================================
  // Temporary polling
  // Later replaced by Socket.IO
  // ==========================================

  useEffect(() => {
    fetchCurrentStatus();

    const interval = setInterval(() => {
      fetchCurrentStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // ==========================================
  // Loading State
  // ==========================================

  if (loading) {
    return (
      <div className="center-message">
        Loading cold-storage data...
      </div>
    );
  }

  // ==========================================
  // Error State
  // ==========================================

  if (error) {
    return (
      <div className="center-message error">
        <h2>⚠ Backend Offline</h2>
        <p>{error}</p>
      </div>
    );
  }

  const { sensorData, risk } = data;

  return (
    <div className="dashboard">
      {/* Header */}

      <header className="header">
        <div>
          <h1>Smart Cold Storage</h1>
          <p>Environmental Monitoring Dashboard</p>
        </div>

        <div className="system-status">
          <span className="status-dot"></span>
          System Online
        </div>
      </header>

      {/* Sensor Cards */}

      <section className="sensor-grid">
        <div className="card">
          <p className="card-label">Temperature</p>

          <h2>
            {sensorData.temperature}
            <span> °C</span>
          </h2>

          <p>Cold storage temperature</p>
        </div>

        <div className="card">
          <p className="card-label">Humidity</p>

          <h2>
            {sensorData.humidity}
            <span> %</span>
          </h2>

          <p>Relative humidity</p>
        </div>

        <div className="card">
          <p className="card-label">Door Status</p>

          <h2>
            {sensorData.doorOpen
              ? "OPEN 🚨"
              : "CLOSED ✅"}
          </h2>

          <p>
            {sensorData.doorOpen
              ? "Door is currently open"
              : "Door is secured"}
          </p>
        </div>
      </section>

      {/* Risk Section */}

      <section className="risk-card">
        <div className="risk-header">
          <div>
            <p className="card-label">
              Environmental Storage Risk
            </p>

            <h2 className={`risk-level ${risk.level.toLowerCase()}`}>
              {risk.level}
            </h2>
          </div>

          <div className="risk-score">
            <strong>{risk.score}</strong>
            <span>/100</span>
          </div>
        </div>

        <div className="risk-bar">
          <div
            className="risk-fill"
            style={{
              width: `${risk.score}%`,
            }}
          ></div>
        </div>

        <div className="risk-reasons">
          <h3>Risk Analysis</h3>

          {risk.reasons.map((reason, index) => (
            <p key={index}>• {reason}</p>
          ))}
        </div>
      </section>

      {/* Last Updated */}

      <footer className="footer">
        Last updated:{" "}
        {new Date(
          sensorData.timestamp
        ).toLocaleString()}
      </footer>
    </div>
  );
}

export default App;