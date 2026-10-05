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

const COLORS = [
  { color: "#0f5c56", light: "#0f5c5633" },
  { color: "#9a3412", light: "#9a341233" },
  { color: "#1d4e89", light: "#1d4e8933" },
  { color: "#6b3fa0", light: "#6b3fa033" },
  { color: "#9f1239", light: "#9f123933" },
  { color: "#3f6212", light: "#3f621233" },
  { color: "#a16207", light: "#a1620733" },
  { color: "#0f4c5c", light: "#0f4c5c33" },
];

function pick<T>(items: readonly T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? items[0]!;
}

export function generateIdentity(): Identity {
  const palette = pick(COLORS);
  return {
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: palette.color,
    colorLight: palette.light,
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
    if (isIdentity(parsed)) return parsed;
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
