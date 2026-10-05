import { Server, type Connection, type Document } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  appendUpdate,
  closeDatabase,
  listUpdateBlobs,
  openDatabase,
  readHistory,
  readStoredUpdate,
  recordUpdate,
} from "./db";
import { isDocumentName } from "./documentName";

const PORT = 1234;
const TEXT_FIELD = "content";
const WELCOME_TEXT = [
  "This is a shared document.",
  "",
  "Open this page in another browser tab to edit it together. Each person gets a name, and every change is appended to SQLite on the server.",
  "",
].join("\n");

openDatabase();

function loadDocument(documentName: string): Uint8Array {
  const stored = listUpdateBlobs(documentName);
  if (stored.length === 0) {
    const draft = new Y.Doc();
    draft.getText(TEXT_FIELD).insert(0, WELCOME_TEXT);
    const update = Y.encodeStateAsUpdate(draft);
    draft.destroy();
    appendUpdate(documentName, update, WELCOME_TEXT);
    console.log(`[sync] created "${documentName}"`);
    return update;
  }

  console.log(`[sync] loaded "${documentName}" from ${stored.length} updates`);
  return stored.length === 1 ? stored[0]! : Y.mergeUpdates(stored);
}

const server = new Server({
  port: PORT,
  address: "127.0.0.1",
  name: "collab-editor",
  async onLoadDocument({ documentName }) {
    if (!isDocumentName(documentName)) {
      throw new Error(`Invalid document name: ${documentName}`);
    }
    // Returned before the change hook is attached, so reloading does not
    // append another copy of history.
    return loadDocument(documentName);
  },
  async onChange({ documentName, document, update, connection }) {
    try {
      recordUpdate(
        documentName,
        update,
        document.getText(TEXT_FIELD).toString(),
        authorName(document, connection),
      );
    } catch (error) {
      console.error(`[db] failed to store an update for "${documentName}"`, error);
    }
  },
  async onConnect({ documentName, socketId }) {
    console.log(`[sync] ${socketId} joined "${documentName}"`);
  },
  async onDisconnect({ documentName, socketId }) {
    console.log(`[sync] ${socketId} left "${documentName}"`);
  },
  onRequest({ request, response }) {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/")) {
        resolve(undefined);
        return;
      }

      try {
        if (url.pathname === "/api/health") {
          sendJson(response, 200, { ok: true });
          reject();
          return;
        }

        const updateMatch = /^\/api\/documents\/([^/]+)\/updates\/(\d+)$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && updateMatch?.[1] && updateMatch[2]) {
          const documentName = decodeURIComponent(updateMatch[1]);
          const updateId = Number(updateMatch[2]);
          if (!isDocumentName(documentName) || !Number.isSafeInteger(updateId)) {
            sendJson(response, 400, { error: "Invalid document name." });
            reject();
            return;
          }
          const update = readStoredUpdate(documentName, updateId);
          if (!update) {
            sendJson(response, 404, { error: "Stored change not found." });
            reject();
            return;
          }
          sendJson(response, 200, { document: documentName, update });
          reject();
          return;
        }

        const historyMatch = /^\/api\/documents\/([^/]+)\/updates$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && historyMatch?.[1]) {
          const documentName = decodeURIComponent(historyMatch[1]);
          if (!isDocumentName(documentName)) {
            sendJson(response, 400, { error: "Invalid document name." });
            reject();
            return;
          }
          const limit = clampLimit(url.searchParams.get("limit"));
          const history = readHistory(documentName, limit);
          sendJson(response, 200, { document: documentName, ...history });
          reject();
          return;
        }

        sendJson(response, 404, { error: "Not found." });
        reject();
      } catch (error) {
        console.error("[http] request failed", error);
        sendJson(response, 500, { error: "Failed to read stored changes." });
        reject();
      }
    });
  },
});

function authorName(
  document: Document,
  connection: Connection | undefined,
): string | null {
  if (!connection) return null;
  for (const clientId of document.getClients(connection)) {
    const state = document.awareness.getStates().get(clientId) as
      | { user?: { name?: string } }
      | undefined;
    const name = state?.user?.name?.trim();
    if (name) return name;
  }
  return null;
}

function clampLimit(value: string | null): number {
  const parsed = Number(value ?? 40);
  if (!Number.isInteger(parsed)) return 40;
  return Math.min(100, Math.max(1, parsed));
}

function sendJson(
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

void server.listen();
console.log(`[sync] listening on ws://127.0.0.1:${PORT}`);

function shutdown(): void {
  void server.destroy().finally(() => {
    closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
