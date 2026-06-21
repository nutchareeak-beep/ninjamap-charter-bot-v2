import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const logFile = path.join(dataDir, "acceptance-logs.json");
const snapshotFile = path.join(dataDir, "role-snapshots.json");

async function ensureDataFile() {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(logFile, "utf8");
  } catch {
    await writeFile(logFile, "[]\n", "utf8");
  }
}

export async function readAcceptanceLogs() {
  await ensureDataFile();
  const raw = await readFile(logFile, "utf8");
  return JSON.parse(raw);
}

async function ensureJsonFile(filePath) {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, "[]\n", "utf8");
  }
}

export async function writeAcceptanceLogs(logs) {
  await ensureDataFile();
  await writeFile(logFile, `${JSON.stringify(logs, null, 2)}\n`, "utf8");
}

export async function upsertAcceptanceLog(entry) {
  const logs = await readAcceptanceLogs();
  const index = logs.findIndex(
    (item) => item.userId === entry.userId && item.charterVersion === entry.charterVersion
  );

  if (index >= 0) {
    logs[index] = { ...logs[index], ...entry };
  } else {
    logs.push(entry);
  }

  await writeAcceptanceLogs(logs);
  return entry;
}

export async function exportLogsCsv() {
  const logs = await readAcceptanceLogs();
  const header = [
    "discord_user_id",
    "username",
    "accepted_sections",
    "accepted_at",
    "charter_version"
  ];

  const rows = logs.map((log) => [
    log.userId,
    log.username,
    log.acceptedSections.join("; "),
    log.acceptedAt,
    log.charterVersion
  ]);

  const escapeCell = (value) => {
    const text = String(value ?? "");
    return `"${text.replaceAll("\"", "\"\"")}"`;
  };

  return [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
}

export async function readRoleSnapshots() {
  await ensureJsonFile(snapshotFile);
  const raw = await readFile(snapshotFile, "utf8");
  return JSON.parse(raw);
}

export async function writeRoleSnapshots(snapshots) {
  await ensureJsonFile(snapshotFile);
  await writeFile(snapshotFile, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
}

export async function upsertRoleSnapshot(entry) {
  const snapshots = await readRoleSnapshots();
  const index = snapshots.findIndex(
    (item) => item.userId === entry.userId && item.charterVersion === entry.charterVersion
  );

  if (index >= 0) {
    snapshots[index] = { ...snapshots[index], ...entry };
  } else {
    snapshots.push(entry);
  }

  await writeRoleSnapshots(snapshots);
  return entry;
}

export async function getRoleSnapshot(userId, charterVersion) {
  const snapshots = await readRoleSnapshots();
  return snapshots.find((item) => item.userId === userId && item.charterVersion === charterVersion) || null;
}
