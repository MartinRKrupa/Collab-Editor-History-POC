export type Identity = {
  name: string;
  color: string;
  colorLight: string;
};

const STORAGE_KEY = "collab-editor.identity";

const ADJECTIVES = [
  "Brisk",
  "Calm",
  "Bright",
  "Quiet",
  "Keen",
  "Bold",
  "Gentle",
  "Rapid",
  "Steady",
  "Vivid",
  "Amber",
  "Silver",
  "Cedar",
  "Coral",
  "Harbor",
  "Marble",
];

const ANIMALS = [
  "Otter",
  "Falcon",
  "Heron",
  "Badger",
  "Lynx",
  "Plover",
  "Marten",
  "Newt",
  "Finch",
  "Kelp",
  "Bison",
  "Ibis",
  "Wren",
  "Moose",
  "Pika",
  "Tern",
];

/** Shown until the server assigns this document's shared color. */
const PENDING_COLOR = { color: "#57534e", colorLight: "#f5f5f4" };

function pick<T>(items: readonly T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? items[0]!;
}

export function generateIdentity(): Identity {
  return {
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: PENDING_COLOR.color,
    colorLight: PENDING_COLOR.colorLight,
  };
}

export function loadIdentity(): Identity {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const created = generateIdentity();
    saveIdentity(created);
    return created;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isIdentity(parsed)) {
      return {
        ...parsed,
        color: PENDING_COLOR.color,
        colorLight: PENDING_COLOR.colorLight,
      };
    }
  } catch {
    // Replace a corrupt saved identity with a fresh one.
  }

  const created = generateIdentity();
  saveIdentity(created);
  return created;
}

export function saveIdentity(identity: Identity): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name.trim().length > 0 &&
    typeof record.color === "string" &&
    typeof record.colorLight === "string"
  );
}
