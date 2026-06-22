import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
const logFile = path.join(dataDir, "acceptance-logs.json");
const snapshotFile = path.join(dataDir, "role-snapshots.json");
const databaseUrl = process.env.DATABASE_URL || null;

let poolPromise = null;

async function getPool() {
  if (!databaseUrl) return null;
  if (!poolPromise) {
    poolPromise = import("pg").then(async ({ Pool }) => {
      const pool = new Pool({
        connectionString: databaseUrl,
        ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
      });

      await pool.query(`
        CREATE TABLE IF NOT EXISTS acceptance_logs (
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          charter_version TEXT NOT NULL,
          accepted_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
          accepted_section_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          accepted_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, charter_version)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS role_snapshots (
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          charter_version TEXT NOT NULL,
          removed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          actually_removed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          failed_removed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          restored_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          failed_restored_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
          snapshot_at TIMESTAMPTZ,
          removed_at TIMESTAMPTZ,
          restored_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'snapshot_saved',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, charter_version)
        )
      `);

      return pool;
    });
  }

  return poolPromise;
}

function dbAcceptanceToEntry(row) {
  return {
    userId: row.user_id,
    username: row.username,
    acceptedSections: row.accepted_sections || [],
    acceptedSectionIds: row.accepted_section_ids || [],
    acceptedAt: row.accepted_at?.toISOString?.() || row.accepted_at,
    charterVersion: row.charter_version
  };
}

function dbSnapshotToEntry(row) {
  return {
    userId: row.user_id,
    username: row.username,
    charterVersion: row.charter_version,
    removedRoles: row.removed_roles || [],
    actuallyRemovedRoles: row.actually_removed_roles || [],
    failedRemovedRoles: row.failed_removed_roles || [],
    restoredRoles: row.restored_roles || [],
    failedRestoredRoles: row.failed_restored_roles || [],
    snapshotAt: row.snapshot_at?.toISOString?.() || row.snapshot_at,
    removedAt: row.removed_at?.toISOString?.() || row.removed_at,
    restoredAt: row.restored_at?.toISOString?.() || row.restored_at,
    status: row.status
  };
}

async function ensureDataFile() {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(logFile, "utf8");
  } catch {
    await writeFile(logFile, "[]\n", "utf8");
  }
}

async function ensureJsonFile(filePath) {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, "[]\n", "utf8");
  }
}

export async function readAcceptanceLogs() {
  const pool = await getPool();
  if (pool) {
    const result = await pool.query("SELECT * FROM acceptance_logs ORDER BY accepted_at DESC");
    return result.rows.map(dbAcceptanceToEntry);
  }

  await ensureDataFile();
  const raw = await readFile(logFile, "utf8");
  return JSON.parse(raw);
}

export async function writeAcceptanceLogs(logs) {
  await ensureDataFile();
  await writeFile(logFile, `${JSON.stringify(logs, null, 2)}\n`, "utf8");
}

export async function upsertAcceptanceLog(entry) {
  const pool = await getPool();
  if (pool) {
    await pool.query(
      `
        INSERT INTO acceptance_logs (
          user_id,
          username,
          charter_version,
          accepted_sections,
          accepted_section_ids,
          accepted_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NOW())
        ON CONFLICT (user_id, charter_version)
        DO UPDATE SET
          username = EXCLUDED.username,
          accepted_sections = EXCLUDED.accepted_sections,
          accepted_section_ids = EXCLUDED.accepted_section_ids,
          accepted_at = EXCLUDED.accepted_at,
          updated_at = NOW()
      `,
      [
        entry.userId,
        entry.username,
        entry.charterVersion,
        JSON.stringify(entry.acceptedSections || []),
        JSON.stringify(entry.acceptedSectionIds || []),
        entry.acceptedAt
      ]
    );
    return entry;
  }

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
  const pool = await getPool();
  if (pool) {
    const result = await pool.query("SELECT * FROM role_snapshots ORDER BY updated_at DESC");
    return result.rows.map(dbSnapshotToEntry);
  }

  await ensureJsonFile(snapshotFile);
  const raw = await readFile(snapshotFile, "utf8");
  return JSON.parse(raw);
}

export async function writeRoleSnapshots(snapshots) {
  await ensureJsonFile(snapshotFile);
  await writeFile(snapshotFile, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
}

export async function upsertRoleSnapshot(entry) {
  const pool = await getPool();
  if (pool) {
    await pool.query(
      `
        INSERT INTO role_snapshots (
          user_id,
          username,
          charter_version,
          removed_roles,
          actually_removed_roles,
          failed_removed_roles,
          restored_roles,
          failed_restored_roles,
          snapshot_at,
          removed_at,
          restored_at,
          status,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
          $7::jsonb, $8::jsonb, $9, $10, $11, $12, NOW()
        )
        ON CONFLICT (user_id, charter_version)
        DO UPDATE SET
          username = EXCLUDED.username,
          removed_roles = EXCLUDED.removed_roles,
          actually_removed_roles = EXCLUDED.actually_removed_roles,
          failed_removed_roles = EXCLUDED.failed_removed_roles,
          restored_roles = EXCLUDED.restored_roles,
          failed_restored_roles = EXCLUDED.failed_restored_roles,
          snapshot_at = EXCLUDED.snapshot_at,
          removed_at = EXCLUDED.removed_at,
          restored_at = EXCLUDED.restored_at,
          status = EXCLUDED.status,
          updated_at = NOW()
      `,
      [
        entry.userId,
        entry.username,
        entry.charterVersion,
        JSON.stringify(entry.removedRoles || []),
        JSON.stringify(entry.actuallyRemovedRoles || []),
        JSON.stringify(entry.failedRemovedRoles || []),
        JSON.stringify(entry.restoredRoles || []),
        JSON.stringify(entry.failedRestoredRoles || []),
        entry.snapshotAt || null,
        entry.removedAt || null,
        entry.restoredAt || null,
        entry.status || "snapshot_saved"
      ]
    );
    return entry;
  }

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
  const pool = await getPool();
  if (pool) {
    const result = await pool.query(
      "SELECT * FROM role_snapshots WHERE user_id = $1 AND charter_version = $2",
      [userId, charterVersion]
    );
    return result.rows[0] ? dbSnapshotToEntry(result.rows[0]) : null;
  }

  const snapshots = await readRoleSnapshots();
  return snapshots.find((item) => item.userId === userId && item.charterVersion === charterVersion) || null;
}
