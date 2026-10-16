require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await mongoose.connection.db.command({ atlasSize: 1 });
  const mib = Number(result.atlasSize) / (1024 * 1024);
  if (!Number.isFinite(mib)) throw new Error("Atlas returned an invalid size");
  console.log(`Atlas cluster data + indexes: ${mib.toFixed(1)} MiB`);
})().catch((error) => {
  console.error("Storage check failed:", error.message);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
