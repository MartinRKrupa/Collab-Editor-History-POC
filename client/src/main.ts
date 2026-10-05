import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { basicSetup } from "codemirror";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { generateIdentity, loadIdentity, saveIdentity } from "./identity";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "ws://127.0.0.1:1234";
const TEXT_FIELD = "content";
const DOCUMENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type AwarenessUser = {
  name?: string;
  color?: string;
};

type HistoryUpdate = {
  id: number;
  createdAt: string;
  byteLength: number;
  textLength: number;
  charDelta: number;
  authorName: string | null;
  excerpt: string;
};

type HistoryResponse = {
  document: string;
  total: number;
  updates: HistoryUpdate[];
};

type StoredUpdateResponse = {
  document: string;
  update: {
    id: number;
    createdAt: string;
    authorName: string | null;
    charDelta: number;
    text: string;
  };
};

const statusNode = required<HTMLParagraphElement>("#status");
const peopleNode = required<HTMLUListElement>("#people");
const peopleHeading = required<HTMLHeadingElement>("#people-heading");
const historyNode = required<HTMLOListElement>("#history");
const historyCount = required<HTMLParagraphElement>("#history-count");
const editorHost = required<HTMLDivElement>("#editor");
const historyEditorHost = required<HTMLDivElement>("#history-editor");
const historyBanner = required<HTMLDivElement>("#history-banner");
const historyBannerText = required<HTMLParagraphElement>("#history-banner-text");
const returnLiveButton = required<HTMLButtonElement>("#return-live");
const editorMessage = required<HTMLParagraphElement>("#editor-message");
const documentForm = required<HTMLFormElement>("#document-form");
const documentInput = required<HTMLInputElement>("#document-name");
const nameInput = required<HTMLInputElement>("#user-name");
const newNameButton = required<HTMLButtonElement>("#new-name");

const documentName = currentDocumentName();
documentInput.value = documentName;
document.title = `${documentName} · Collab editor`;

let identity = loadIdentity();
nameInput.value = identity.name;

const ydoc = new Y.Doc();
const ytext = ydoc.getText(TEXT_FIELD);
const undoManager = new Y.UndoManager(ytext);
let editor: EditorView | null = null;
let historyEditor: EditorView | null = null;
let historyTimer = 0;
let latestHistory: HistoryResponse | null = null;
let viewedUpdateId: number | null = null;
let viewRequest = 0;

const provider = new HocuspocusProvider({
  url: SERVER_URL,
  name: documentName,
  document: ydoc,
  onStatus({ status }) {
    renderStatus(status);
    if (status === WebSocketStatus.Disconnected && !editor) {
      editorMessage.textContent =
        "Cannot reach the collaboration server. It listens on ws://127.0.0.1:1234.";
    }
  },
  onSynced({ state }) {
    if (state) mountEditor();
  },
  onAwarenessUpdate() {
    renderPeople();
  },
});

publishIdentity();
renderPeople();

nameInput.addEventListener("input", () => {
  const name = nameInput.value.trim();
  if (!name) return;
  identity = { ...identity, name: name.slice(0, 40) };
  saveIdentity(identity);
  publishIdentity();
});

newNameButton.addEventListener("click", () => {
  identity = generateIdentity();
  saveIdentity(identity);
  nameInput.value = identity.name;
  publishIdentity();
});

documentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const next = documentInput.value.trim().toLowerCase();
  if (!DOCUMENT_NAME.test(next)) {
    documentInput.setCustomValidity(
      "Use 1–64 characters: lowercase letters, numbers, and hyphens.",
    );
    documentInput.reportValidity();
    return;
  }
  documentInput.setCustomValidity("");
  const url = new URL(window.location.href);
  url.searchParams.set("doc", next);
  window.location.assign(url);
});

documentInput.addEventListener("input", () => {
  documentInput.setCustomValidity("");
});

ydoc.on("update", () => {
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => {
    void refreshHistory();
  }, 300);
});

void refreshHistory();

function currentDocumentName(): string {
  const requested = new URL(window.location.href).searchParams.get("doc") ?? "welcome";
  if (DOCUMENT_NAME.test(requested)) return requested;
  const url = new URL(window.location.href);
  url.searchParams.set("doc", "welcome");
  history.replaceState(null, "", url);
  return "welcome";
}

function publishIdentity(): void {
  provider.setAwarenessField("user", {
    name: identity.name,
    color: identity.color,
    colorLight: identity.colorLight,
  });
}

function mountEditor(): void {
  if (editor) return;
  editorMessage.hidden = true;
  editor = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness, { undoManager }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    }),
  });
  if (viewedUpdateId === null) editor.focus();
  else editorHost.hidden = true;
}

returnLiveButton.addEventListener("click", () => {
  returnToLive();
});

function renderStatus(status: string): void {
  statusNode.dataset.state = status;
  if (status === "connected") {
    statusNode.textContent = `Connected · ${documentName}`;
    return;
  }
  if (status === "connecting") {
    statusNode.textContent = "Connecting to the server…";
    return;
  }
  statusNode.textContent = "Disconnected. The editor will retry.";
}

function renderPeople(): void {
  const awareness = provider.awareness;
  if (!awareness) return;
  const localId = ydoc.clientID;
  const people = [...awareness.getStates().entries()]
    .map(([clientId, state]) => {
      const user = (state as { user?: AwarenessUser }).user;
      return {
        clientId,
        name: user?.name?.trim() || "Anonymous",
        color: user?.color || "#6f675d",
        self: clientId === localId,
      };
    })
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));

  peopleHeading.textContent =
    people.length === 1
      ? "Collaborating now · 1 person"
      : `Collaborating now · ${people.length} people`;

  peopleNode.replaceChildren(
    ...people.map((person) => {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = person.color;
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "person-name";
      name.textContent = person.name;
      if (person.self) {
        const you = document.createElement("span");
        you.className = "you";
        you.textContent = "you";
        name.append(you);
      }
      item.append(swatch, name);
      return item;
    }),
  );

  if (people.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Waiting for a connection…";
    peopleNode.replaceChildren(empty);
  }
}

async function refreshHistory(): Promise<void> {
  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(documentName)}/updates?limit=40`,
    );
    if (!response.ok) throw new Error(`History request failed (${response.status})`);
    latestHistory = (await response.json()) as HistoryResponse;
    renderHistory(latestHistory);
  } catch (error) {
    historyCount.textContent = "";
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent =
      error instanceof Error ? error.message : "Could not load stored changes.";
    historyNode.replaceChildren(item);
  }
}

async function showStoredUpdate(id: number): Promise<void> {
  if (viewedUpdateId === id) return;
  const request = ++viewRequest;
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentName)}/updates/${id}`,
  );
  if (request !== viewRequest) return;
  if (!response.ok) {
    historyBanner.hidden = false;
    historyBannerText.textContent = "That stored change could not be opened.";
    return;
  }
  const body = (await response.json()) as StoredUpdateResponse;
  if (request !== viewRequest) return;
  showSnapshot(body.update);
}

function showSnapshot(update: StoredUpdateResponse["update"]): void {
  viewedUpdateId = update.id;
  editorMessage.hidden = true;
  editorHost.hidden = true;
  historyEditorHost.hidden = false;
  historyBanner.hidden = false;
  const who = update.authorName ?? "the server";
  historyBannerText.textContent = `Viewing the version stored at ${formatTime(update.createdAt)} by ${who}. Your editor is read-only. Other people can still edit.`;

  historyEditor?.destroy();
  historyEditor = new EditorView({
    parent: historyEditorHost,
    state: EditorState.create({
      doc: update.text,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-readonly": "true" }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    }),
  });
  if (latestHistory) renderHistory(latestHistory);
}

function returnToLive(): void {
  viewRequest += 1;
  viewedUpdateId = null;
  historyEditor?.destroy();
  historyEditor = null;
  historyEditorHost.hidden = true;
  historyEditorHost.replaceChildren();
  historyBanner.hidden = true;
  editorHost.hidden = false;
  editor?.requestMeasure();
  editor?.focus();
  if (latestHistory) renderHistory(latestHistory);
}

function renderHistory(body: HistoryResponse): void {
  historyCount.textContent =
    body.total === 1 ? "1 row" : `${body.total} rows`;
  if (body.updates.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No changes stored yet.";
    historyNode.replaceChildren(item);
    return;
  }

  historyNode.replaceChildren(
    ...body.updates.map((update) => {
      const item = document.createElement("li");
      const selected = viewedUpdateId === update.id;
      if (selected) item.classList.add("is-selected");
      const meta = document.createElement("div");
      meta.className = "meta";
      const time = document.createElement("time");
      time.dateTime = update.createdAt;
      time.textContent = formatTime(update.createdAt);
      const actions = document.createElement("div");
      actions.className = "meta-actions";
      const delta = document.createElement("span");
      const who = update.authorName ?? "server";
      delta.textContent = `${who} ${formatDelta(update.charDelta)}`;
      delta.className = update.charDelta < 0 ? "delta-negative" : "delta-positive";
      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.className = "ghost";
      viewButton.textContent = selected ? "Viewing" : "View";
      viewButton.setAttribute("aria-pressed", selected ? "true" : "false");
      viewButton.addEventListener("click", () => {
        void showStoredUpdate(update.id);
      });
      actions.append(delta, viewButton);
      meta.append(time, actions);

      const excerpt = document.createElement("p");
      excerpt.className = "excerpt";
      excerpt.textContent = update.excerpt || "(empty document)";
      item.append(meta, excerpt);
      return item;
    }),
  );
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}
