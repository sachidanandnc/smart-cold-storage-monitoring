const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const routes = new Map();
const rows = [];
let nextId = 0;
let createdAlerts = 0;
let createdDoorEvents = 0;
let nextLegacyId = 0;
const doorRows = [];

function express() {
  return {
    use() {},
    get(url, handler) { routes.set(`GET ${url}`, handler); },
    post(url, handler) { routes.set(`POST ${url}`, handler); },
  };
}
express.json = () => () => {};
class Schema { index() {} }
const sensor = {
  async updateOne(key, update) {
    if (key._id) {
      const row = rows.find(row => row._id === key._id);
      if (key.processingToken && row.processingToken !== key.processingToken) return { modifiedCount: 0 };
      if (update.$set) Object.assign(row, update.$set);
      if (update.$unset) for (const field of Object.keys(update.$unset)) delete row[field];
      return { modifiedCount: 1 };
    }
    const existing = rows.find(row => row.deviceId === key.deviceId && row.readingId === key.readingId);
    if (existing) return { upsertedCount: 0 };
    rows.push({ ...update.$setOnInsert, _id: `id-${++nextId}`, processingComplete: false });
    return { upsertedCount: 1 };
  },
  findOne(key) {
    if (key.$or) return { sort: async () => rows.filter(row => row.liveEligible && row.processingComplete)
      .sort((a, b) => b.timestamp - a.timestamp)[0] || null };
    return Promise.resolve(rows.find(row => row.deviceId === key.deviceId && row.readingId === key.readingId) || null);
  },
  async findOneAndUpdate(key, update, options) {
    assert.equal(options?.returnDocument, 'after');
    const row = rows.find(row => row._id === key._id);
    if (!row || row.processingComplete || (row.processingLeaseUntil && row.processingLeaseUntil > new Date())) return null;
    Object.assign(row, update.$set);
    return row;
  },
  async findById(id) { return rows.find(row => row._id === id) || null; },
  async exists(query) {
    if (query.capturedAt) {
      return rows.some(row => row.deviceId === query.deviceId && row.processingComplete &&
        row.capturedAt && row.capturedAt > query.capturedAt.$gt);
    }
    return rows.some(row => row.deviceId === query.deviceId && row.readingId === undefined &&
      row.timestamp > query.timestamp.$gt);
  },
};
const alert = {
  async findOne() { return null; },
  async updateMany() {},
  async create() { createdAlerts++; },
};
const doorEvent = {
  findOne(query) {
    const match = doorRows.find(row => row.deviceId === query.deviceId &&
      (query.closedReadingId ? row.closedReadingId === query.closedReadingId :
        row.status === query.status));
    if (query.status) return { async sort() { return match || null; } };
    return Promise.resolve(match || null);
  },
  async create(data) {
    createdDoorEvents++;
    const row = { ...data, durationSeconds: 0, async save() {} };
    doorRows.push(row);
    return row;
  },
};
const models = { SensorData: sensor, Alert: alert, DoorEvent: doorEvent };
const mongoose = {
  Schema,
  Types: { ObjectId: class { toString() { return `legacy-id-${++nextLegacyId}`; } } },
  model(name) { return models[name]; },
};
function fakeRequire(name) {
  if (name === 'express') return express;
  if (name === 'cors') return () => () => {};
  if (name === 'mongoose') return mongoose;
  if (name === 'dotenv') return { config() {} };
  if (name === 'node:crypto') return { randomUUID: () => 'test-token' };
  throw new Error(name);
}
const moduleObject = { exports: {} };
const context = {
  require: fakeRequire,
  module: moduleObject,
  process: { env: {
    TEMP_MIN: '2', TEMP_MAX: '8', HUMIDITY_MIN: '30', HUMIDITY_MAX: '70',
    DOOR_WARNING_SECONDS: '30', DOOR_CRITICAL_SECONDS: '120',
  } },
  console,
};
vm.runInNewContext(source, context, { filename: 'server.js' });
assert.match(
  vm.runInNewContext('logTimeIST(new Date("2026-10-15T00:00:00Z"))', context),
  /05:30:00 IST$/,
);

async function post(body, headers = {}) {
  let statusCode = 200;
  let payload;
  const res = {
    status(n) { statusCode = n; return this; },
    json(data) { payload = data; return this; },
  };
  await routes.get('POST /api/sensor-data')({ body,
    get(name) { return headers[name]; } }, res);
  return { statusCode, payload };
}

async function get(url) {
  let statusCode = 200;
  let payload;
  const res = {
    status(n) { statusCode = n; return this; },
    json(data) { payload = data; return this; },
  };
  await routes.get(`GET ${url}`)({}, res);
  return { statusCode, payload };
}

(async () => {
  const now = new Date();
  const live = {
    deviceId: 'cold-storage-01', readingId: 'test-1',
    temperature: 5.2, humidity: 55, doorOpen: false,
    capturedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    timeQuality: 'ntp', historical: false,
  };
  const first = await post(live);
  assert.equal(first.statusCode, 201);
  assert.equal(first.payload.ack.readingId, 'test-1');
  assert.equal(first.payload.message, 'Sensor data saved');
  assert.equal(first.payload.risk.level, 'LOW');
  assert.equal(first.payload.door.open, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].liveEligible, true);
  const duplicate = await post(live);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.payload.duplicate, true);
  assert.deepEqual(duplicate.payload.risk, first.payload.risk);
  assert.deepEqual(duplicate.payload.door, first.payload.door);
  assert.equal(rows.length, 1);
  const conflict = await post({ ...live, temperature: 6 });
  assert.equal(conflict.statusCode, 409);
  assert.equal(rows[0].temperature, 5.2);
  const old = await post({ ...live, readingId: 'test-2', temperature: 12,
    historical: true, capturedAt: new Date(now.getTime() - 300000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.equal(old.statusCode, 201);
  assert.equal(rows[1].liveEligible, false);
  assert.equal(rows[1].riskReasons[0], 'Temperature is significantly outside the safe range');
  assert.equal(createdAlerts, 0);
  assert.equal(createdDoorEvents, 0);
  const unknown = await post({ ...live, readingId: 'test-3',
    capturedAt: null, timeQuality: 'unknown', historical: true });
  assert.equal(unknown.statusCode, 201);
  assert.equal(rows[2].capturedAt, null);
  assert.equal(rows[2].liveEligible, false);
  assert.equal(rows[2].timestamp.getTime(), rows[2].receivedAt.getTime());
  const latest = await get('/api/sensor-data/latest');
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.payload.data.readingId, 'test-1');
  assert.equal(latest.payload.stale, false);
  const risk = await get('/api/risk/current');
  assert.equal(risk.statusCode, 200);
  assert.equal(risk.payload.sensorData.temperature, 5.2);
  assert.equal(risk.payload.stale, false);
  const delayed = await post({ ...live, readingId: 'test-4', temperature: 12,
    historical: false, capturedAt: new Date(now.getTime() - 120000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.equal(delayed.statusCode, 201);
  assert.equal(rows[3].liveEligible, false);
  assert.equal(createdAlerts, 0);
  const future = await post({ ...live, readingId: 'test-5',
    capturedAt: new Date(now.getTime() + 10000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.equal(future.statusCode, 400);
  assert.equal(rows.length, 4);
  const inFlight = { ...live, readingId: 'test-6' };
  rows.push({ ...moduleObject.exports.parseReading(inFlight, new Date()), _id: 'id-inflight',
    processingComplete: false, processingToken: 'other-worker',
    processingLeaseUntil: new Date(Date.now() + 60000) });
  const busy = await post(inFlight);
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.payload.success, false);
  rows[4].processingLeaseUntil = new Date(Date.now() - 1000);
  const resumed = await post(inFlight);
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.payload.ack.readingId, 'test-6');
  assert.equal(rows[4].processingComplete, true);
  const lostAckRetry = await post(live, { 'X-Queue-Retry': 'true' });
  assert.equal(lostAckRetry.statusCode, 200);
  assert.equal(lostAckRetry.payload.ack.readingId, 'test-1');
  assert.equal(rows[0].historical, false);
  const retryFirstReceived = await post({ ...live, readingId: 'test-7', temperature: 12 },
    { 'X-Queue-Retry': 'true' });
  assert.equal(retryFirstReceived.statusCode, 201);
  assert.equal(rows[5].historical, true);
  assert.equal(rows[5].liveEligible, false);
  assert.equal(createdAlerts, 0);
  const doorOpenedAt = new Date(now.getTime() + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const doorClosedAt = new Date(now.getTime() + 2000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const openHistory = await post({ ...live, readingId: 'test-8',
    capturedAt: doorOpenedAt, historical: true, doorOpen: true });
  assert.equal(openHistory.statusCode, 201);
  assert.equal(openHistory.payload.door.open, true);
  assert.equal(createdDoorEvents, 1);
  const closeHistory = await post({ ...live, readingId: 'test-9',
    capturedAt: doorClosedAt, historical: true, doorOpen: false });
  assert.equal(closeHistory.statusCode, 201);
  assert.equal(closeHistory.payload.door.durationSeconds, 1);
  assert.equal(doorRows[0].status, 'CLOSED');
  assert.equal(doorRows[0].closedReadingId, 'test-9');
  assert.equal(createdAlerts, 0);
  const legacy = await post({ temperature: 5, humidity: 50, doorOpen: false });
  assert.equal(legacy.statusCode, 201);
  assert.equal(legacy.payload.message, 'Sensor data saved');
  assert.equal(rows.at(-1).timeQuality, 'legacy');
  const preGapDoor = { deviceId: 'cold-storage-01', status: 'OPEN',
    openedAt: new Date(now.getTime() - 120000), durationUncertain: false,
    openedReadingId: 'espABC123-n1111111122222222-b0000000001-r000001',
    async save() {} };
  doorRows.push(preGapDoor);
  const unknownGap = await post({ ...live,
    readingId: 'espABC123-n3333333344444444-b0000000002-r000001',
    capturedAt: null, timeQuality: 'unknown', historical: true, doorOpen: true });
  assert.equal(unknownGap.statusCode, 201);
  assert.equal(preGapDoor.durationUncertain, true);
  const afterGapAt = new Date(now.getTime() + 3000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const afterGap = await post({ ...live,
    readingId: 'espABC123-n3333333344444444-b0000000002-r000002',
    capturedAt: afterGapAt, doorOpen: true });
  assert.equal(afterGap.statusCode, 201);
  assert.equal(afterGap.payload.door.durationSeconds, 0);
  assert.equal(preGapDoor.durationSeconds, null);
  assert.equal(createdAlerts, 0);
  const currentDoor = doorRows.at(-1);
  const oldUnknown = await post({ ...live,
    readingId: 'espABC123-n1111111122222222-b0000000001-r999999',
    capturedAt: null, timeQuality: 'unknown', historical: true, doorOpen: true });
  assert.equal(oldUnknown.statusCode, 201);
  assert.notEqual(currentDoor.durationUncertain, true);
  const reusedBootNumber = await post({ ...live,
    readingId: 'espABC123-n5555555566666666-b0000000002-r000003',
    capturedAt: null, timeQuality: 'unknown', historical: true, doorOpen: true });
  assert.equal(reusedBootNumber.statusCode, 201);
  assert.notEqual(currentDoor.durationUncertain, true);
  const pendingBody = { ...live, readingId: 'test-pending', temperature: 12,
    doorOpen: false,
    capturedAt: new Date(now.getTime() + 4000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const pending = { ...moduleObject.exports.parseReading(pendingBody, new Date()),
    _id: 'id-pending', processingComplete: false };
  assert.equal(pending.liveEligible, true);
  rows.push(pending);
  const resumedAsHistory = await post(pendingBody, { 'X-Queue-Retry': 'true' });
  assert.equal(resumedAsHistory.statusCode, 200);
  assert.equal(pending.processingComplete, true);
  assert.equal(pending.historical, true);
  assert.equal(pending.liveEligible, false);
  assert.equal(createdAlerts, 0);
  const legacyOpenDoor = { deviceId: 'cold-storage-01', status: 'OPEN',
    openedAt: new Date(now.getTime() + 5000), async save() {} };
  doorRows.push(legacyOpenDoor);
  const prePhaseRow = { deviceId: 'cold-storage-01',
    timestamp: new Date(now.getTime() + 5000) };
  rows.push(prePhaseRow);
  const oldAgainstLegacy = await post({ ...pendingBody, readingId: 'test-old-legacy',
    historical: true });
  assert.equal(oldAgainstLegacy.statusCode, 201);
  assert.equal(legacyOpenDoor.status, 'OPEN');
  rows.splice(rows.indexOf(prePhaseRow), 1);
  // Test the active-event time guard even without a legacy sensor row.
  const oldAgainstEvent = await post({ ...pendingBody, readingId: 'test-old-event',
    historical: true });
  assert.equal(oldAgainstEvent.statusCode, 201);
  assert.equal(legacyOpenDoor.status, 'OPEN');
  console.log('PASS: ACK, duplicate, ID conflict, live isolation, clocks, door replay, unknown clock gap, unfinished retry, legacy chronology');
})().catch(error => { console.error(error); process.exitCode = 1; });
