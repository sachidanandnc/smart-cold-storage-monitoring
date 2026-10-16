const MIB = 1024 * 1024;

function storageLimitMiB(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) {
    throw new Error("Storage watermarks must be whole MiB values from 1 to 500");
  }
  return number;
}

function createStorageMaintainer({ connection, SensorData, Alert, DoorEvent, latestFilter, highMiB = 420,
  lowMiB = 380, batchSize = 2000, log = console }) {
  if (!(lowMiB < highMiB)) throw new Error("STORAGE_LOW_WATER_MIB must be below STORAGE_HIGH_WATER_MIB");
  let busy = false;
  let trimming = false;

  return async function trimOldestReadings() {
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      // Atlas Free's atlasSize includes documents and indexes across the cluster.
      const stats = await connection.db.command({ atlasSize: 1 });
      const bytes = Number(stats.atlasSize);
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Atlas returned an invalid storage size");
      if (bytes >= highMiB * MIB) trimming = true;
      if (bytes <= lowMiB * MIB) trimming = false;
      if (!trimming) return { bytes, deleted: 0 };

      // Keep the current dashboard reading even when its captured time is old.
      const latest = await SensorData.findOne(latestFilter)
        .sort({ timestamp: -1 }).select({ _id: 1 }).lean();
      const cutoff = new Date(Date.now() - 60000);
      const filter = {
        // Pre-Phase-21 records have no processingComplete field; new pending
        // records explicitly have false and must never be pruned.
        processingComplete: { $ne: false },
        $or: [
          { receivedAt: { $lt: cutoff } },
          { receivedAt: { $exists: false }, timestamp: { $lt: cutoff } },
        ],
      };
      if (latest) filter._id = { $ne: latest._id };
      // ObjectId order follows insertion order, including unknown-time history.
      const oldest = await SensorData.find(filter)
        .sort({ _id: 1 }).limit(batchSize).select({ _id: 1 }).lean();
      if (!oldest.length) {
        // These collections are much smaller. Preserve unresolved alerts and
        // the currently open door event; prune their closed history only if
        // no eligible sensor reading remains.
        for (const [model, archivedFilter, order] of [
          [Alert, { resolved: true, timestamp: { $lt: cutoff } }, { timestamp: 1 }],
          [DoorEvent, { status: "CLOSED", openedAt: { $lt: cutoff } }, { openedAt: 1 }],
        ]) {
          if (!model) continue;
          const archived = await model.find(archivedFilter)
            .sort(order).limit(batchSize).select({ _id: 1 }).lean();
          if (!archived.length) continue;
          const ids = archived.map((row) => row._id);
          const result = await model.deleteMany({
            ...archivedFilter, _id: { $in: ids },
          });
          const deleted = result.deletedCount || 0;
          log.warn(`Atlas storage ${Math.round(bytes / MIB)} MiB; removed ${deleted} oldest archived records`);
          return { bytes, deleted };
        }
        log.warn("Storage high, but no old completed or archived records can be removed");
        return { bytes, deleted: 0, exhausted: true };
      }
      const ids = oldest.map((row) => row._id);
      const result = await SensorData.deleteMany({
        _id: { $in: ids, ...(latest ? { $ne: latest._id } : {}) },
        processingComplete: { $ne: false },
      });
      const deleted = result.deletedCount || 0;
      log.warn(`Atlas storage ${Math.round(bytes / MIB)} MiB; removed ${deleted} oldest completed readings`);
      return { bytes, deleted };
    } catch (error) {
      log.error("Storage maintenance failed:", error.message);
      return { error: error.message };
    } finally {
      busy = false;
    }
  };
}

module.exports = { createStorageMaintainer, storageLimitMiB };
