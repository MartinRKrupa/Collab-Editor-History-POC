# Collab editor

A plain-text editor shared through a single server. Clients edit a [Yjs](https://docs.yjs.dev/) document, and the server is the only sync point: it applies every update, records it in SQLite, and broadcasts it to the other clients.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173 in two browser tabs. Each tab gets its own generated name. Edits in one tab show up in the other, along with that person's cursor.

The page also lists everyone currently connected and the change rows stored on the server.

Another document is a separate Yjs room: change the document field to something like `notes` and choose Open, or visit `http://127.0.0.1:5173/?doc=notes`.

## How it fits together

- `client` is a Vite + TypeScript page. CodeMirror 6 binds to a `Y.Text` through `y-codemirror.next`. `@hocuspocus/provider` speaks the Yjs sync protocol over a WebSocket. Names and colors travel on the Yjs awareness channel, which is presence only and is not written into the document history.
- `server` is a TypeScript [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction) process on `ws://127.0.0.1:1234`. There is no peer-to-peer provider.
- SQLite lives at `server/data/collab.sqlite` (Node's built-in `node:sqlite`). The `updates` table stores Yjs binary updates. Consecutive edits by the same person are merged into one row; an edit by someone else starts a new row. Replaying those blobs rebuilds the document. `text_after` is the plain text after that row, so the log can be read without decoding CRDT frames. Rows that already existed before this rule are left unchanged.

| Table | What it stores |
| --- | --- |
| `documents` | One row per document name |
| `updates` | `update_blob`, the text after that update, the character delta, the collaborator name when the edit came from a connected client, and a timestamp |

`GET /api/documents/:name/updates` returns the newest rows. The dev server proxies `/api` to the collaboration server.

Names are stored in `sessionStorage`, so each tab is a different collaborator and a refresh keeps the name for that tab.
