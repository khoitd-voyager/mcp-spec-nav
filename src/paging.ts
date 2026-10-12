import { createHash } from "node:crypto";

/**
 * Pagination shared by every tool that can return more than fits in a reply.
 *
 * A page ends at whichever comes first: the item limit or the character
 * budget. It never ends by dropping items — whatever did not fit is the next
 * page, reachable through the cursor, and the output says so in so many words.
 */

/** Roughly the point where a tool result stops fitting comfortably in a reply. */
export const CHAR_BUDGET = 30_000;

interface CursorBody {
  /** Which tool issued it. */
  t: string;
  /** Hash of the query parameters, so a cursor is not replayed on another query. */
  q: string;
  /** Position: an offset, or a sort key to resume after. */
  p: number | string;
  /** Fingerprint of the files in scope when the first page was produced. */
  f: string;
}

export function paramsHash(params: unknown): string {
  return createHash("sha1").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 10);
}

export function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body)).toString("base64url");
}

export interface CursorState {
  position: number | string | undefined;
  /** Set when files changed between the first page and this one. */
  changedSinceFirstPage: boolean;
  /** Fingerprint to carry forward: the first page's, so a change is reported on every later page. */
  fingerprint: string;
}

export function decodeCursor(
  cursor: string | undefined,
  tool: string,
  qHash: string,
  currentFingerprint: string,
): CursorState {
  if (!cursor) return { position: undefined, changedSinceFirstPage: false, fingerprint: currentFingerprint };
  let body: CursorBody;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor. Pass the `nextCursor` value from the previous page exactly as given.");
  }
  if (body.t !== tool || body.q !== qHash) {
    throw new Error(
      "This cursor belongs to a different query. Repeat the call with the same arguments as the " +
        "page that returned it, or drop the cursor to start from the first page.",
    );
  }
  return { position: body.p, changedSinceFirstPage: body.f !== currentFingerprint, fingerprint: body.f };
}

export const CHANGED_WARNING =
  "WARNING: files changed since the first page of this listing. Items already returned may have " +
  "moved or changed; restart without a cursor for a consistent listing.";

/**
 * Take items starting at `start` until `limit` items or `budget` characters.
 * Always takes at least one item, so a single oversized item cannot stall
 * the pages.
 */
export function takePage<T>(
  items: T[],
  start: number,
  limit: number,
  budget: number,
  render: (item: T, index: number) => string,
): { rendered: string[]; end: number } {
  const rendered: string[] = [];
  let used = 0;
  let i = start;
  for (; i < items.length && rendered.length < limit; i++) {
    const text = render(items[i], i);
    if (rendered.length && used + text.length + 1 > budget) break;
    rendered.push(text);
    used += text.length + 1;
  }
  return { rendered, end: i };
}
