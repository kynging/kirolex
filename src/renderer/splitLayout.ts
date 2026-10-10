/**
 * Split-pane geometry. Pure functions, no React and no Electron, so the rules can be
 * exercised directly in tests (see tests/splitLayout.test.ts) instead of by dragging
 * dividers in a running app.
 */

/** Dragged proportions for one layout. `rows` is per row, `cols[r]` per cell in row r. */
export type SplitSizes = { shape: string; rows: number[]; cols: number[][] };

/** A row of panes; a cell is a session id, or null for a placeholder row. */
export type PaneRow = (string | null)[];

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

/** A stored flex value, or 1 when it is absent or not a usable number.
 *
 *  Needed because `carrySplitSizes` returns stored sizes UNTOUCHED on an exact shape
 *  match, so a corrupted ui-state.json reaches the readers below unvalidated: indexing
 *  a string `rows` yields a character, and a character in `flexGrow` silently collapses
 *  a row to nothing. */
const flexOr1 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1);

/**
 * Carry dragged proportions across a layout change instead of discarding them.
 *
 * Sizes used to be all-or-nothing: the stored object was honoured only when its
 * `shape` key matched EXACTLY, and that key includes the pane count. So opening a 4th
 * chat in a 2x2 grid ('2x2:3:r' -> '2x2:4:-') threw away every divider the user had
 * dragged -- including the ones whose structure had not changed at all. Going 3 -> 4
 * there still has two rows, and the top row still holds the same two panes; only the
 * bottom row genuinely gains a column. Resetting the row heights and the top row's
 * split as well was pure collateral damage.
 *
 * So: match by INDEX. Rows and columns that still exist keep their exact flex; a newly
 * appeared column takes the average of the ones already in its row, so a row going from
 * one pane to two lands on 50/50.
 *
 * @param stored Previously dragged sizes, or null when nothing was ever dragged.
 * @param shape The current layout key (see the caller's `splitShape`).
 * @param rowsOfPanes The current rows, which decide the output dimensions.
 * @returns Sizes stamped with `shape`, or null when there was nothing to carry.
 */
export function carrySplitSizes(
  stored: SplitSizes | null,
  shape: string,
  rowsOfPanes: PaneRow[],
): SplitSizes | null {
  if (!stored) return null;
  if (stored.shape === shape) return stored;
  const storedRows = Array.isArray(stored.rows) ? stored.rows : [];
  const storedCols = Array.isArray(stored.cols) ? stored.cols : [];
  return {
    shape,
    rows: rowsOfPanes.map((_, r) => storedRows[r] ?? avg(storedRows)),
    cols: rowsOfPanes.map((row, r) => {
      const prev = Array.isArray(storedCols[r]) ? storedCols[r] : [];
      const fill = avg(prev);
      return row.map((_, c) => prev[c] ?? fill);
    }),
  };
}

/** All dragged sizes, one bucket per shape. Key order is recency: the last key is the
 *  most recently written bucket (see `putSplitSizes`). */
export type SplitSizeStore = Record<string, SplitSizes>;

/** What may be on disk: the bucketed store, or the old single `SplitSizes` object. */
type StoredSplitSizes = SplitSizes | SplitSizeStore | null | undefined;

const isSizes = (v: unknown): v is SplitSizes =>
  !!v && typeof v === 'object' && typeof (v as SplitSizes).shape === 'string';

/** Normalise either stored format into a fresh bucket map (the old single object
 *  becomes its own shape's bucket). Junk entries are dropped. */
function toStore(stored: StoredSplitSizes): SplitSizeStore {
  const out: SplitSizeStore = {};
  if (!stored || typeof stored !== 'object') return out;
  if (isSizes(stored)) {
    out[stored.shape] = stored;
    return out;
  }
  for (const [k, v] of Object.entries(stored)) if (isSizes(v)) out[k] = v;
  return out;
}

/**
 * The dragged sizes for exactly this shape, or null when this shape was never dragged.
 *
 * Sizes are stored per shape because a drag belongs to one layout: with a single stored
 * object, dragging in a 3-pane grid replaced what you had dragged in the 2-pane one, so
 * going back to 2 panes no longer looked the way you left it.
 */
export function pickSplitSizes(stored: StoredSplitSizes, shape: string): SplitSizes | null {
  return toStore(stored)[shape] ?? null;
}

/** True when these sizes are the even split nobody dragged: every value is 1, or
 *  missing / not a number (which the readers also treat as 1). */
export function isNeutralSizes(v: SplitSizes | null | undefined): boolean {
  if (!v) return true;
  const rows = Array.isArray(v.rows) ? v.rows : [];
  const cols = Array.isArray(v.cols) ? v.cols.filter(Array.isArray).flat() : [];
  return [...rows, ...cols].every((n) => !(typeof n === 'number' && Number.isFinite(n)) || Math.abs(n - 1) < 1e-9);
}

/**
 * Write `next` into its own shape's bucket, leaving every other bucket alone, and make it
 * the most recent one (an unseen shape carries from it, see `activeSplitSizes`).
 *
 * An even split never overwrites a dragged one: dragging always changes a proportion,
 * so the only way to get all-1s here is a write that is not a drag, and letting it
 * through would erase a drag for good. Evening a shape out is `resetSplitSizes`.
 */
export function putSplitSizes(stored: StoredSplitSizes, next: SplitSizes): SplitSizeStore {
  const out = toStore(stored);
  if (isNeutralSizes(next) && out[next.shape] && !isNeutralSizes(out[next.shape])) return out;
  delete out[next.shape];
  out[next.shape] = next;
  return out;
}

/**
 * Double-click on a divider: even out THIS shape only. It used to clear the whole store,
 * which also threw away every other layout's drags.
 *
 * The shape gets an explicit empty (= even) bucket rather than none at all, because a
 * shape without a bucket carries from the latest drag (`activeSplitSizes`) and would
 * not even out. The bucket also becomes the latest, so a shape seen for the first time
 * after a reset starts even too -- as it did when a reset cleared everything.
 */
export function resetSplitSizes(stored: StoredSplitSizes, shape: string): SplitSizeStore {
  const out = toStore(stored);
  delete out[shape];
  out[shape] = { shape, rows: [], cols: [] };
  return out;
}

/**
 * The sizes to lay out `shape` with: its own bucket when it has one, otherwise the most
 * recently dragged bucket carried over by index (`carrySplitSizes`), so adding a pane
 * still keeps the dividers whose structure did not change.
 */
export function activeSplitSizes(
  stored: StoredSplitSizes,
  shape: string,
  rowsOfPanes: PaneRow[],
): SplitSizes | null {
  const store = toStore(stored);
  const own = store[shape];
  if (own) return own;
  const keys = Object.keys(store);
  return carrySplitSizes(keys.length ? store[keys[keys.length - 1]] : null, shape, rowsOfPanes);
}

/**
 * Flex grow per pane, per row. The panes divide their row BETWEEN THEM: free capacity
 * to the right of a row is a slim strip of fixed width, not a share of the row.
 *
 * Which shape the free space takes is the one design rule here, and it splits on
 * whether a whole ROW is free or only a CELL:
 *   - a free CELL in a row that already holds a chat is a SLIM STRIP, so the chat in
 *     that row uses the full width. Consequence, accepted deliberately: filling that
 *     cell later halves the pane, and until then the bottom pane's right edge does not
 *     line up with the divider above it.
 *   - a free ROW reserves its real height instead (see `emptyRowFlex`), because half a
 *     window of empty space is what that capacity will actually occupy, and reserving
 *     it means the next chat lands there without moving the rows above.
 *
 * Dragged values are matched by index and inherited from the row above when a row has
 * none of its own, so a divider dragged in the top row stays lined up below.
 *
 * @param rowsOfPanes Rows of pane ids.
 * @param sizes Dragged sizes to read from, already carried for this layout.
 * @returns One array of flex-grow values per row, in pane order.
 */
export function computePaneFlex(rowsOfPanes: PaneRow[], sizes: SplitSizes | null): number[][] {
  return rowsOfPanes.map((row, r) => row.map((_, c) => flexOr1(
    sizes?.cols?.[r]?.[c]
    ?? (r > 0 ? sizes?.cols?.[r - 1]?.[c] : undefined),
  )));
}

/**
 * Free capacity is a slim strip of FIXED size, on both axes -- there is deliberately no
 * function here that sizes it.
 *
 * A previous version gave a fully empty row a real row's height, so that a chat added
 * later landed exactly on the placeholder and the rows above it never resized. That is
 * true, and it was still wrong: with two chats in a 2x2 it turned the bottom half of
 * the window into an empty box. Reserving space for a chat that is not there costs more
 * than the alignment it buys, so the panes on screen always get the whole window and
 * the placeholder stays a hint.
 */
