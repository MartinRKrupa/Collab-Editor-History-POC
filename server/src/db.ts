import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const dataDirectory = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "data",
);

const databasePath = path.join(dataDirectory, "collab.sqlite");

export type StoredUpdate = {
  id: number;
  createdAt: string;
  byteLength: number;
  textLength: number;
  charDelta: number;
  authorName: string | null;
  excerpt: string;
};

let database: DatabaseSync | null = null;

function asNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function toUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export function openDatabase(): DatabaseSync {
  if (database) return database;

  fs.mkdirSync(dataDirectory, { recursive: true });
  database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      update_blob BLOB NOT NULL,
      text_after TEXT NOT NULL,
      char_delta INTEGER NOT NULL,
      author_name TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS updates_document_id_id_idx
      ON updates (document_id, id);
  `);
  ensureCollapsibleColumn(database);

  console.log(`[db] sqlite ${databasePath}`);
  return database;
}

export function databaseFilePath(): string {
  return databasePath;
}

function ensureDocument(name: string): number {
  const db = openDatabase();
  db.prepare(
    "INSERT INTO documents (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
  ).run(name);
  const row = db.prepare("SELECT id FROM documents WHERE name = ?").get(name) as
    | { id: number | bigint }
    | undefined;
  if (!row) {
    throw new Error(`Document row missing for "${name}"`);
  }
  return asNumber(row.id);
}

export function listUpdateBlobs(name: string): Uint8Array[] {
  const db = openDatabase();
  const document = db
    .prepare("SELECT id FROM documents WHERE name = ?")
    .get(name) as { id: number | bigint } | undefined;
  if (!document) return [];

  const rows = db
    .prepare(
      "SELECT update_blob FROM updates WHERE document_id = ? ORDER BY id ASC",
    )
    .all(asNumber(document.id)) as Array<{ update_blob: Uint8Array }>;

  return rows.map((row) => toUint8Array(row.update_blob));
}

function ensureCollapsibleColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(updates)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "collapsible")) return;
  db.exec(
    "ALTER TABLE updates ADD COLUMN collapsible INTEGER NOT NULL DEFAULT 0",
  );
}

/**
 * Store a collaborator edit. Consecutive new edits by the same person become
 * one row. A different preceding author, or any row written before this rule,
 * ends the run and starts a new row. Existing rows are not rewritten.
 */
export function recordUpdate(
  name: string,
  update: Uint8Array,
  textAfter: string,
  authorName: string | null,
): number {
  const db = openDatabase();
  const documentId = ensureDocument(name);
  const streak =
    authorName === null ? [] : trailingCollapsibleStreak(db, documentId, authorName);
  if (streak.length === 0) {
    return insertUpdate(db, documentId, update, textAfter, authorName, true);
  }

  const anchorId = streak[0]!;
  const blobs = streak.map((id) => readUpdateBlob(db, id));
  const merged = Y.mergeUpdates([...blobs, update]);
  const baselineLength = textLengthBefore(db, documentId, anchorId);
  const charDelta = textAfter.length - baselineLength;
  const absorbed = streak.slice(1);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE updates
       SET update_blob = ?, text_after = ?, char_delta = ?,
           created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run(merged, textAfter, charDelta, anchorId);
    if (absorbed.length > 0) {
      const placeholders = absorbed.map(() => "?").join(", ");
      db.prepare(`DELETE FROM updates WHERE id IN (${placeholders})`).run(
        ...absorbed,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log(
    `[db] merged edit into #${anchorId} for "${name}" by ${authorName} (${merged.byteLength} bytes, ${textAfter.length} chars, delta ${charDelta})`,
  );
  return anchorId;
}

function trailingCollapsibleStreak(
  db: DatabaseSync,
  documentId: number,
  authorName: string,
): number[] {
  const rows = db
    .prepare(
      `SELECT id, author_name, collapsible
       FROM updates
       WHERE document_id = ?
       ORDER BY id DESC`,
    )
    .all(documentId) as Array<{
    id: number | bigint;
    author_name: string | null;
    collapsible: number | bigint;
  }>;

  const streak: number[] = [];
  for (const row of rows) {
    if (asNumber(row.collapsible) !== 1 || row.author_name !== authorName) break;
    streak.push(asNumber(row.id));
  }
  streak.reverse();
  return streak;
}

function readUpdateBlob(db: DatabaseSync, id: number): Uint8Array {
  const row = db
    .prepare("SELECT update_blob FROM updates WHERE id = ?")
    .get(id) as { update_blob: Uint8Array } | undefined;
  if (!row) throw new Error(`Update #${id} disappeared before it could be merged`);
  return toUint8Array(row.update_blob);
}

function textLengthBefore(
  db: DatabaseSync,
  documentId: number,
  updateId: number,
): number {
  const previous = db
    .prepare(
      `SELECT text_after
       FROM updates
       WHERE document_id = ? AND id < ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(documentId, updateId) as { text_after: string } | undefined;
  return previous?.text_after.length ?? 0;
}

function insertUpdate(
  db: DatabaseSync,
  documentId: number,
  update: Uint8Array,
  textAfter: string,
  authorName: string | null,
  collapsible: boolean,
): number {
  const previous = db
    .prepare(
      "SELECT text_after FROM updates WHERE document_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(documentId) as { text_after: string } | undefined;
  const charDelta = textAfter.length - (previous?.text_after.length ?? 0);
  const result = db
    .prepare(
      `INSERT INTO updates (
         document_id, update_blob, text_after, char_delta, author_name, collapsible
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      documentId,
      update,
      textAfter,
      charDelta,
      authorName,
      collapsible ? 1 : 0,
    );
  const id = asNumber(result.lastInsertRowid);
  const who = authorName ?? "server";
  console.log(
    `[db] stored update #${id} for "${nameFromDocument(db, documentId)}" by ${who} (${update.byteLength} bytes, ${textAfter.length} chars, delta ${charDelta})`,
  );
  return id;
}

function nameFromDocument(db: DatabaseSync, documentId: number): string {
  const row = db.prepare("SELECT name FROM documents WHERE id = ?").get(documentId) as
    | { name: string }
    | undefined;
  return row?.name ?? String(documentId);
}

export function appendUpdate(
  name: string,
  update: Uint8Array,
  textAfter: string,
  authorName: string | null = null,
): number {
  const db = openDatabase();
  return insertUpdate(
    db,
    ensureDocument(name),
    update,
    textAfter,
    authorName,
    false,
  );
}

export function readHistory(
  name: string,
  limit: number,
): { total: number; updates: StoredUpdate[] } {
  const db = openDatabase();
  const document = db
    .prepare("SELECT id FROM documents WHERE name = ?")
    .get(name) as { id: number | bigint } | undefined;
  if (!document) return { total: 0, updates: [] };

  const documentId = asNumber(document.id);
  const totalRow = db
    .prepare("SELECT count(*) AS total FROM updates WHERE document_id = ?")
    .get(documentId) as { total: number | bigint };
  const rows = db
    .prepare(
      `SELECT id, created_at, text_after, char_delta, author_name, length(update_blob) AS byte_length
       FROM updates
       WHERE document_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(documentId, limit) as Array<{
    id: number | bigint;
    created_at: string;
    text_after: string;
    char_delta: number | bigint;
    author_name: string | null;
    byte_length: number | bigint;
  }>;

  return {
    total: asNumber(totalRow.total),
    updates: rows.map((row) => ({
      id: asNumber(row.id),
      createdAt: row.created_at,
      byteLength: asNumber(row.byte_length),
      textLength: row.text_after.length,
      charDelta: asNumber(row.char_delta),
      authorName: row.author_name,
      excerpt: excerpt(row.text_after),
    })),
  };
}

export function readStoredUpdate(
  name: string,
  updateId: number,
): {
  id: number;
  createdAt: string;
  authorName: string | null;
  charDelta: number;
  text: string;
} | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `SELECT u.id, u.created_at, u.text_after, u.char_delta, u.author_name
       FROM updates u
       JOIN documents d ON d.id = u.document_id
       WHERE d.name = ? AND u.id = ?`,
    )
    .get(name, updateId) as
    | {
        id: number | bigint;
        created_at: string;
        text_after: string;
        char_delta: number | bigint;
        author_name: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: asNumber(row.id),
    createdAt: row.created_at,
    authorName: row.author_name,
    charDelta: asNumber(row.char_delta),
    text: row.text_after,
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 180) return flat;
  return `${flat.slice(0, 179)}…`;
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}
