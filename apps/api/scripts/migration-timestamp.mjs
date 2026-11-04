export function normalizeLatestMigrationTimestamp(entries, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Drizzle migration journal has no entries.");
  }

  const previousTimestamps = entries.slice(0, -1).map((entry) => Number(entry.when));
  if (previousTimestamps.some((timestamp) => !Number.isSafeInteger(timestamp))) {
    throw new Error("A prior Drizzle migration has an invalid timestamp; refusing to rewrite migration history.");
  }

  const latest = entries[entries.length - 1];
  const latestTimestamp = Number(latest.when);
  const maxPriorTimestamp = previousTimestamps.length > 0 ? Math.max(...previousTimestamps) : 0;
  if (Number.isSafeInteger(latestTimestamp) && latestTimestamp > maxPriorTimestamp) {
    return { changed: false, previousTimestamp: latestTimestamp, timestamp: latestTimestamp };
  }

  if (!Number.isSafeInteger(now)) {
    throw new Error("The timestamp normalization clock must be a safe integer.");
  }
  const timestamp = Math.max(now, maxPriorTimestamp + 1);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("Could not produce a safe timestamp for the new migration.");
  }

  latest.when = timestamp;
  return { changed: true, previousTimestamp: latestTimestamp, timestamp };
}

export function latestMigrationTimestampIsAfterHistory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const timestamps = entries.map((entry) => Number(entry.when));
  if (timestamps.some((timestamp) => !Number.isSafeInteger(timestamp))) return false;
  const latestTimestamp = timestamps[timestamps.length - 1];
  const priorTimestamps = timestamps.slice(0, -1);
  return priorTimestamps.length === 0 || latestTimestamp > Math.max(...priorTimestamps);
}
