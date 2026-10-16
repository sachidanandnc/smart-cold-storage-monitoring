const assert = require("node:assert/strict");
process.env.TEMP_MIN = "2";
process.env.TEMP_MAX = "8";
process.env.HUMIDITY_MIN = "40";
process.env.HUMIDITY_MAX = "80";
process.env.DOOR_WARNING_SECONDS = "10";
process.env.DOOR_CRITICAL_SECONDS = "20";
process.env.DEVICE_API_KEY = "test-device-key-with-at-least-32-chars";
process.env.DASHBOARD_READ_KEY = "test-dashboard-key-with-at-least-32-chars";
process.env.CORS_ORIGIN = "https://dashboard.example.test";

const { app } = require("./server");
const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(base);
    assert.equal(health.status, 200);

    const deniedRead = await fetch(base + "/api/risk/current");
    assert.equal(deniedRead.status, 401);

    const deniedPost = await fetch(base + "/api/sensor-data", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(deniedPost.status, 401);

    const allowed = await fetch(base, { headers: { Origin: "https://dashboard.example.test" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://dashboard.example.test");
    const blocked = await fetch(base, { headers: { Origin: "https://other.example.test" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    console.log("PASS: upload auth, dashboard auth, and browser origin restriction");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
