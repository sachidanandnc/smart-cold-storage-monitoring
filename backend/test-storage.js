const assert = require("node:assert/strict");
const { createStorageMaintainer } = require("./storage-maintenance");
const MiB = 1024 * 1024;
const removed = [];
let bytes = 425 * MiB;
const query = (value) => ({
  sort() { return this; },
  limit() { return this; },
  select() { return this; },
  async lean() { return value; },
});
const SensorData = {
  findOne() { return query({ _id: 3 }); },
  find(filter) {
    assert.deepEqual(filter.processingComplete, { $ne: false });
    assert.equal(filter._id.$ne, 3);
    return query([{ _id: 1 }, { _id: 2 }]);
  },
  async deleteMany(filter) {
    assert.deepEqual(filter.processingComplete, { $ne: false });
    assert.equal(filter._id.$ne, 3);
    removed.push(...filter._id.$in);
    return { deletedCount: filter._id.$in.length };
  },
};
const trim = createStorageMaintainer({
  connection: { db: { async command(command) {
    assert.deepEqual(command, { atlasSize: 1 });
    return { atlasSize: bytes };
  } } },
  SensorData,
  latestFilter: { liveEligible: true },
  highMiB: 420,
  lowMiB: 380,
  log: { warn() {}, error() {} },
});
(async () => {
  assert.equal((await trim()).deleted, 2);
  assert.deepEqual(removed, [1, 2]);
  bytes = 390 * MiB;
  assert.equal((await trim()).deleted, 2); // Continue down to low watermark.
  bytes = 375 * MiB;
  assert.equal((await trim()).deleted, 0);
  bytes = 410 * MiB;
  assert.equal((await trim()).deleted, 0); // Do not restart below high watermark.
  const archived = [];
  const trimArchived = createStorageMaintainer({
    connection: { db: { async command() { return { atlasSize: 425 * MiB }; } } },
    SensorData: {
      findOne() { return query({ _id: 3 }); },
      find() { return query([]); },
    },
    Alert: {
      find(filter) { assert.equal(filter.resolved, true); return query([{ _id: 7 }]); },
      async deleteMany(filter) { assert.equal(filter.resolved, true); archived.push(...filter._id.$in); return { deletedCount: 1 }; },
    },
    DoorEvent: { find() { throw new Error("Closed-door cleanup should wait until resolved alerts are exhausted"); } },
    latestFilter: {}, log: { warn() {}, error() {} },
  });
  assert.equal((await trimArchived()).deleted, 1);
  assert.deepEqual(archived, [7]);
  console.log("PASS: rolling storage prunes oldest completed readings and archived alerts, while protecting live status");
})().catch((error) => { console.error(error); process.exitCode = 1; });
