import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
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
  color: string;
  colorLight: string;
  excerpt: string;
};

type HistoryResponse = {
  document: string;
  total: number;
  updates: HistoryUpdate[];
};

type AttributionSpan = {
  start: number;
  end: number;
  authorName: string | null;
  color: string;
  colorLight: string;
};

type StoredUpdateResponse = {
  document: string;
  update: {
    id: number;
    createdAt: string;
    authorName: string | null;
    charDelta: number;
    text: string;
    attributions: AttributionSpan[];
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
const historyLegend = required<HTMLUListElement>("#history-legend");
const returnLiveButton = required<HTMLButtonElement>("#return-live");
const revertDialog = required<HTMLDialogElement>("#revert-dialog");
const revertDialogText = required<HTMLParagraphElement>("#revert-dialog-text");
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
let colorRequest = 0;
let colorTimer = 0;
let resettingPage = false;

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
  onStateless({ payload }) {
    if (!isResetMessage(payload)) return;
    resetPage();
  },
});

publishIdentity();
renderPeople();
void claimColor();

nameInput.addEventListener("input", () => {
  const name = nameInput.value.trim();
  if (!name) return;
  identity = { ...identity, name: name.slice(0, 40) };
  saveIdentity(identity);
  publishIdentity();
  scheduleClaim();
});

nameInput.addEventListener("blur", () => {
  if (!identity.name.trim()) return;
  claimNow();
});

newNameButton.addEventListener("click", () => {
  identity = generateIdentity();
  saveIdentity(identity);
  nameInput.value = identity.name;
  publishIdentity();
  claimNow();
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

function resetPage(): void {
  if (resettingPage) return;
  resettingPage = true;
  provider.configuration.websocketProvider.disconnect();
  window.location.reload();
}

function isResetMessage(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as { type?: unknown }).type === "reset"
    );
  } catch {
    return false;
  }
}

function publishIdentity(): void {
  provider.setAwarenessField("user", {
    name: identity.name,
    color: identity.color,
    colorLight: identity.colorLight,
  });
}

function scheduleClaim(): void {
  window.clearTimeout(colorTimer);
  colorTimer = window.setTimeout(() => {
    void claimColor();
  }, 400);
}

function claimNow(): void {
  window.clearTimeout(colorTimer);
  void claimColor();
}

async function claimColor(): Promise<void> {
  const request = ++colorRequest;
  const name = identity.name;
  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(documentName)}/authors`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (request !== colorRequest || !response.ok) return;
    const body = (await response.json()) as { color?: string; colorLight?: string };
    if (request !== colorRequest || identity.name !== name) return;
    if (!body.color || !body.colorLight) return;
    identity = { ...identity, color: body.color, colorLight: body.colorLight };
    saveIdentity(identity);
    publishIdentity();
  } catch {
    // The next edit or rename claims again. Presence stays on the placeholder until then.
  }
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
        color: user?.color || "#57534e",
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
  historyBannerText.textContent = `Viewing the version stored at ${formatTime(update.createdAt)} by ${who}. Color shows who wrote each part. Your editor is read-only. Other people can still edit.`;
  renderLegend(update.attributions);

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
        authorMarks(update.text, update.attributions),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    }),
  });
  if (latestHistory) renderHistory(latestHistory);
}

function authorMarks(text: string, spans: AttributionSpan[]) {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of spans) {
    if (span.start < 0 || span.end <= span.start || span.end > text.length) continue;
    const label = span.authorName ?? "server";
    builder.add(
      span.start,
      span.end,
      Decoration.mark({
        class: "cm-author",
        attributes: {
          "data-author": label,
          title: label,
          style: `color: ${span.color}; background-color: ${span.colorLight}`,
        },
      }),
    );
  }
  return EditorView.decorations.of(builder.finish());
}

function renderLegend(spans: AttributionSpan[]): void {
  const seen = new Set<string>();
  const items: HTMLLIElement[] = [];
  for (const span of spans) {
    const label = span.authorName ?? "server";
    if (seen.has(label)) continue;
    seen.add(label);
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = span.color;
    swatch.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = label;
    item.append(swatch, name);
    items.push(item);
  }
  historyLegend.replaceChildren(...items);
  historyLegend.hidden = items.length === 0;
}

function returnToLive(): void {
  viewRequest += 1;
  viewedUpdateId = null;
  historyEditor?.destroy();
  historyEditor = null;
  historyEditorHost.hidden = true;
  historyEditorHost.replaceChildren();
  historyBanner.hidden = true;
  historyLegend.hidden = true;
  historyLegend.replaceChildren();
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
      const who = document.createElement("span");
      who.className = "history-author";
      who.textContent = update.authorName ?? "server";
      who.style.color = update.color;
      delta.textContent = formatDelta(update.charDelta);
      delta.className = update.charDelta < 0 ? "delta-negative" : "delta-positive";
      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.className = "ghost";
      viewButton.textContent = selected ? "Viewing" : "View";
      viewButton.setAttribute("aria-pressed", selected ? "true" : "false");
      viewButton.addEventListener("click", () => {
        void showStoredUpdate(update.id);
      });
      actions.append(who, delta, viewButton);
      const latestId = body.updates[0]?.id;
      if (update.id !== latestId) {
        const revertButton = document.createElement("button");
        revertButton.type = "button";
        revertButton.className = "ghost danger";
        revertButton.textContent = "Revert";
        revertButton.addEventListener("click", () => {
          void revertTo(update);
        });
        actions.append(revertButton);
      }
      meta.append(time, actions);

      const excerpt = document.createElement("p");
      excerpt.className = "excerpt";
      excerpt.textContent = update.excerpt || "(empty document)";
      item.append(meta, excerpt);
      return item;
    }),
  );
}

function confirmRevert(update: HistoryUpdate): Promise<boolean> {
  const who = update.authorName ?? "the server";
  revertDialogText.textContent = `Revert the shared document to the version stored at ${formatTime(update.createdAt)} by ${who}? Every change stored after that version is deleted for everyone.`;
  revertDialog.showModal();
  return new Promise((resolve) => {
    revertDialog.addEventListener(
      "close",
      () => {
        resolve(revertDialog.returnValue === "revert");
      },
      { once: true },
    );
  });
}

async function revertTo(update: HistoryUpdate): Promise<void> {
  if (revertDialog.open || resettingPage) return;
  const confirmed = await confirmRevert(update);
  if (!confirmed || resettingPage) return;
  const confirmButton = revertDialog.querySelector<HTMLButtonElement>("#revert-confirm");
  if (confirmButton) confirmButton.disabled = true;
  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(documentName)}/updates/${update.id}/revert`,
      { method: "POST" },
    );
    if (resettingPage) return;
    if (!response.ok) {
      statusNode.textContent = "That version could not be restored.";
      return;
    }
    resetPage();
  } catch {
    if (!resettingPage) statusNode.textContent = "That version could not be restored.";
  } finally {
    if (confirmButton) confirmButton.disabled = false;
  }
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
