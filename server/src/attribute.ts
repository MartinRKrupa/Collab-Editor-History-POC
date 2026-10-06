import { diffChars } from "diff";

export type TextVersion = {
  authorName: string | null;
  text: string;
};

export type AttributionSpan = {
  start: number;
  end: number;
  authorName: string | null;
};

/**
 * Replay stored snapshots in order. Characters that survive keep the author
 * who introduced them; characters inserted by a later snapshot take that author.
 */
export function attributeAuthors(versions: readonly TextVersion[]): AttributionSpan[] {
  let authors: Array<string | null> = [];
  let text = "";

  for (const version of versions) {
    const next: Array<string | null> = [];
    let oldIndex = 0;
    for (const part of diffChars(text, version.text)) {
      if (part.added) {
        for (let index = 0; index < part.value.length; index += 1) {
          next.push(version.authorName);
        }
        continue;
      }
      if (part.removed) {
        oldIndex += part.value.length;
        continue;
      }
      next.push(...authors.slice(oldIndex, oldIndex + part.value.length));
      oldIndex += part.value.length;
    }
    if (next.length !== version.text.length || oldIndex !== text.length) {
      throw new Error("Could not attribute a stored version to its authors");
    }
    authors = next;
    text = version.text;
  }

  const spans: AttributionSpan[] = [];
  for (let index = 0; index < authors.length; index += 1) {
    const authorName = authors[index] ?? null;
    const previous = spans.at(-1);
    if (previous && previous.authorName === authorName && previous.end === index) {
      previous.end = index + 1;
      continue;
    }
    spans.push({ start: index, end: index + 1, authorName });
  }
  return spans;
}
