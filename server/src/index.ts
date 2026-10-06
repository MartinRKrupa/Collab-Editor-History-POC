import { Server, type Connection, type Document } from "@hocuspocus/server";
import * as Y from "yjs";
import { attributeAuthors } from "./attribute";
import {
  appendUpdate,
  authorColorMap,
  claimAuthorColor,
  closeDatabase,
  listUpdateBlobs,
  listVersionsUntil,
  openDatabase,
  readHistory,
  readStoredUpdate,
  recordUpdate,
  truncateUpdatesAfter,
} from "./db";
import { isDocumentName } from "./documentName";
import { SERVER_COLOR, type AuthorColor } from "./palette";

const PORT = 1234;
const resettingDocuments = new Set<string>();
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
  async beforeHandleMessage({ documentName }) {
    if (resettingDocuments.has(documentName)) {
      throw new Error("Document is reverting");
    }
  },
  async onChange({ documentName, document, update, connection }) {
    if (resettingDocuments.has(documentName)) return;
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

        const authorMatch = /^\/api\/documents\/([^/]+)\/authors$/.exec(url.pathname);
        if (request.method === "POST" && authorMatch?.[1]) {
          const documentName = decodeURIComponent(authorMatch[1]);
          void readBody(request)
            .then((raw) => {
              try {
                if (!isDocumentName(documentName)) {
                  sendJson(response, 400, { error: "Invalid document name." });
                  reject();
                  return;
                }
                const name = authorNameFromBody(raw);
                if (!name) {
                  sendJson(response, 400, { error: "Enter a name." });
                  reject();
                  return;
                }
                const palette = claimAuthorColor(documentName, name);
                sendJson(response, 200, {
                  name,
                  color: palette.color,
                  colorLight: palette.colorLight,
                });
                reject();
              } catch (error) {
                console.error("[http] request failed", error);
                sendJson(response, 500, { error: "Failed to assign a color." });
                reject();
              }
            })
            .catch((error: unknown) => {
              console.error("[http] request failed", error);
              sendJson(response, 400, { error: "Invalid request." });
              reject();
            });
          return;
        }

        const revertMatch = /^\/api\/documents\/([^/]+)\/updates\/(\d+)\/revert$/.exec(
          url.pathname,
        );
        if (request.method === "POST" && revertMatch?.[1] && revertMatch[2]) {
          const documentName = decodeURIComponent(revertMatch[1]);
          const updateId = Number(revertMatch[2]);
          if (!isDocumentName(documentName) || !Number.isSafeInteger(updateId)) {
            sendJson(response, 400, { error: "Invalid document name." });
            reject();
            return;
          }
          void revertDocument(documentName, updateId)
            .then((result) => {
              if (!result) {
                sendJson(response, 404, { error: "Stored change not found." });
              } else {
                sendJson(response, 200, { document: documentName, updateId, ...result });
              }
              reject();
            })
            .catch((error: unknown) => {
              console.error("[http] request failed", error);
              sendJson(response, 500, { error: "Failed to revert the document." });
              reject();
            });
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
          const versions = listVersionsUntil(documentName, updateId);
          sendJson(response, 200, {
            document: documentName,
            update: {
              ...update,
              attributions: colorAttributions(
                documentName,
                attributeAuthors(versions),
              ),
            },
          });
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
          const colors = authorColorMap(documentName);
          sendJson(response, 200, {
            document: documentName,
            total: history.total,
            updates: history.updates.map((update) => ({
              ...update,
              ...colorForAuthorName(colors, update.authorName),
            })),
          });
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

async function revertDocument(
  documentName: string,
  updateId: number,
): Promise<{ removed: number } | null> {
  resettingDocuments.add(documentName);
  try {
    const result = truncateUpdatesAfter(documentName, updateId);
    if (!result) return null;

    const hocuspocus = server.hocuspocus;
    const document = hocuspocus.documents.get(documentName);
    if (!document) return result;

    // Clients must discard their copy. Merging the old document back in
    // would recreate the changes that were just deleted.
    document.broadcastStateless(JSON.stringify({ type: "reset" }));
    hocuspocus.closeConnections(documentName);
    const debounceId = `onStoreDocument-${documentName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    if (hocuspocus.documents.get(documentName) === document) {
      hocuspocus.documents.delete(documentName);
      try {
        document.destroy();
      } catch (error) {
        console.error(`[sync] failed to drop "${documentName}" after revert`, error);
      }
    }
    return result;
  } finally {
    resettingDocuments.delete(documentName);
  }
}

function authorName(
  document: Document,
  connection: Connection | undefined,
): string | null {
  if (!connection) return null;
  for (const clientId of document.getClients(connection)) {
    const state = document.awareness.getStates().get(clientId) as
      | { user?: { name?: string } }
      | undefined;
    const name = state?.user?.name?.trim().slice(0, 40);
    if (name) return name;
  }
  return null;
}

function colorAttributions(
  documentName: string,
  spans: Array<{ start: number; end: number; authorName: string | null }>,
): Array<{
  start: number;
  end: number;
  authorName: string | null;
  color: string;
  colorLight: string;
}> {
  const colors = authorColorMap(documentName);
  return spans.map((span) => ({
    ...span,
    ...colorForAuthorName(colors, span.authorName),
  }));
}

function colorForAuthorName(
  colors: Map<string, AuthorColor>,
  authorName: string | null,
): AuthorColor {
  if (!authorName) return SERVER_COLOR;
  return colors.get(authorName) ?? SERVER_COLOR;
}

function authorNameFromBody(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : null;
}

function readBody(request: {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  destroy(): void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > 2048) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
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
