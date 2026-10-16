const assert = require("node:assert/strict");
process.env.TEMP_MIN = "2";
process.env.TEMP_MAX = "8";
process.env.HUMIDITY_MIN = "40";
process.env.HUMIDITY_MAX = "80";
process.env.DOOR_WARNING_SECONDS = "10";
process.env.DOOR_CRITICAL_SECONDS = "20";
process.env.DEVICE_API_KEY = "test-device-key-with-at-least-32-chars";
// A leftover Render variable must no longer impose a dashboard key requirement.
process.env.DASHBOARD_READ_KEY = "obsolete-dashboard-key-for-test-only";
process.env.CORS_ORIGIN = "https://dashboard.example.test";

const { app, models } = require("./server");
// Test the real routes and middleware without contacting a real database.
const reading = {
  timestamp: new Date(), capturedAt: new Date(), receivedAt: new Date(),
  temperature: 4.5, humidity: 65, doorOpen: false,
  riskScore: 0, riskLevel: "LOW", riskReasons: [],
};
models.SensorData.findOne = () => ({ sort: async () => reading });
models.SensorData.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [reading] }) }) });
models.DoorEvent.find = models.Alert.find = () => ({ sort: () => ({ limit: async () => [] }) });
const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    for (const path of ["/api/risk/current", "/api/sensor-data/latest", "/api/sensor-data/history?limit=50", "/api/door-events", "/api/alerts"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `${path} must work without a dashboard key`);
      assert.equal((await response.json()).success, true);
    }
    for (const key of [null, "incorrect-device-key"]) {
      const headers = { "Content-Type": "application/json" };
      if (key) headers["X-Device-Key"] = key;
      const response = await fetch(base + "/api/sensor-data", { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 401, "Public reads must not permit unauthenticated device uploads");
    }
    const validated = await fetch(base + "/api/sensor-data", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Device-Key": process.env.DEVICE_API_KEY }, body: "{}",
    });
    assert.equal(validated.status, 400, "Authenticated uploads still require valid sensor input");
    const allowed = await fetch(base, { headers: { Origin: "https://dashboard.example.test" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://dashboard.example.test");
    const blocked = await fetch(base, { headers: { Origin: "https://other.example.test" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    console.log("PASS: public reads for all dashboard endpoints, protected uploads, input validation and browser origin restriction");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
