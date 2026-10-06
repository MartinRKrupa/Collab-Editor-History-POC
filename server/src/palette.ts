export type AuthorColor = {
  color: string;
  colorLight: string;
};

/** First five are far apart in hue. Later slots stay separate from those five. */
const EDITOR_COLORS: readonly AuthorColor[] = [
  { color: "#1d4ed8", colorLight: "#dbeafe" },
  { color: "#c2410c", colorLight: "#ffedd5" },
  { color: "#15803d", colorLight: "#dcfce7" },
  { color: "#a21caf", colorLight: "#fae8ff" },
  { color: "#0e7490", colorLight: "#cffafe" },
  { color: "#be123c", colorLight: "#ffe4e6" },
  { color: "#6d28d9", colorLight: "#ede9fe" },
  { color: "#a16207", colorLight: "#fef3c7" },
];

export const SERVER_COLOR: AuthorColor = {
  color: "#57534e",
  colorLight: "#f5f5f4",
};

export function colorForIndex(index: number): AuthorColor {
  const palette = EDITOR_COLORS[index % EDITOR_COLORS.length];
  return palette ?? SERVER_COLOR;
}
