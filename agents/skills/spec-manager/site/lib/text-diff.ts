// Inline diff of a text across the three Git states of a spec: HEAD, the
// index (staged), and the working tree (unstaged). Pure and shared by the
// client and the tests.
//
// The diff is word-level, with a character-level refinement inside a changed
// word that is mostly unchanged, so a one-word edit marks the word (or just
// the changed characters) instead of the whole line.

export type SegmentKind = "same" | "removed" | "unstaged" | "staged";

export type Segment = { text: string; kind: SegmentKind };

// One aligned row of the three versions: the index of the item in each list,
// or undefined where that version has no such item.
export type MergedRow = { h?: number; i?: number; w?: number };

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const WORD = /^[\p{L}\p{N}_]+$/u;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

// Longest common subsequence that maximizes the summed similarity of the
// matched pairs (a pair only matches when sim > 0). Returns the pairs in
// order; unmatched items pair with null.
export function align<T>(
  a: T[],
  b: T[],
  sim: (x: T, y: T) => number,
): Array<[number | null, number | null]> {
  const n = a.length;
  const m = b.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const gain: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let x = 1; x <= n; x++) {
    for (let y = 1; y <= m; y++) {
      const g = sim(a[x - 1], b[y - 1]);
      gain[x - 1][y - 1] = g;
      let best = Math.max(score[x - 1][y], score[x][y - 1]);
      if (g > 0) best = Math.max(best, score[x - 1][y - 1] + g);
      score[x][y] = best;
    }
  }
  const out: Array<[number | null, number | null]> = [];
  let x = n;
  let y = m;
  // Backtracking from the end, so preferring an insertion or deletion over a
  // match pushes ambiguous changes toward the end (appended text is marked
  // as appended), and taking the insertion first puts it after the deletion
  // in the result: a replacement reads removed-then-added.
  while (x > 0 || y > 0) {
    if (y > 0 && (x === 0 || score[x][y] === score[x][y - 1])) {
      out.push([null, y - 1]);
      y--;
    } else if (x > 0 && (y === 0 || score[x][y] === score[x - 1][y])) {
      out.push([x - 1, null]);
      x--;
    } else {
      out.push([x - 1, y - 1]);
      x--;
      y--;
    }
  }
  return out.reverse();
}

// Aligns HEAD, the index, and the working tree using the index as the pivot:
// HEAD is aligned to the index, the index to the working tree.
export function mergeThree<T>(
  h: T[],
  i: T[],
  w: T[],
  sim: (x: T, y: T) => number,
): MergedRow[] {
  const hOfI = new Array<number | undefined>(i.length).fill(undefined);
  const wOfI = new Array<number | undefined>(i.length).fill(undefined);
  const headBefore: number[][] = Array.from({ length: i.length + 1 }, () => []);
  const wtBefore: number[][] = Array.from({ length: i.length + 1 }, () => []);

  let consumed = 0;
  for (const [hi, ii] of align(h, i, sim)) {
    if (ii === null) headBefore[consumed].push(hi as number);
    else {
      if (hi !== null) hOfI[ii] = hi;
      consumed++;
    }
  }
  consumed = 0;
  for (const [ii, wi] of align(i, w, sim)) {
    if (ii === null) wtBefore[consumed].push(wi as number);
    else {
      if (wi !== null) wOfI[ii] = wi;
      consumed++;
    }
  }

  // Items only in the working tree follow the run of index items they
  // replace, so a replaced word reads removed-then-added.
  const rows: MergedRow[] = [];
  let pending: number[] = [];
  const flush = () => {
    for (const wi of pending) rows.push({ w: wi });
    pending = [];
  };
  for (let p = 0; p <= i.length; p++) {
    for (const hi of headBefore[p]) rows.push({ h: hi });
    pending.push(...wtBefore[p]);
    if (p === i.length) break;
    if (wOfI[p] !== undefined) flush();
    rows.push({ h: hOfI[p], i: p, w: wOfI[p] });
  }
  flush();
  return rows;
}

function push(out: Segment[], text: string, kind: SegmentKind): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

// Within a removed word directly followed by an added word, keeps the
// common prefix and suffix as unchanged text when they make up at least half
// of the longer word ("run" -> "runs" marks only the "s").
function refineWords(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (let k = 0; k < segs.length; k++) {
    const cur = segs[k];
    const next = segs[k + 1];
    if (
      cur.kind === "removed" &&
      next &&
      (next.kind === "staged" || next.kind === "unstaged") &&
      WORD.test(cur.text) &&
      WORD.test(next.text)
    ) {
      const a = cur.text;
      const b = next.text;
      const min = Math.min(a.length, b.length);
      let pre = 0;
      while (pre < min && a[pre] === b[pre]) pre++;
      let suf = 0;
      while (suf < min - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      if (pre + suf > 0 && (pre + suf) * 2 >= Math.max(a.length, b.length)) {
        push(out, a.slice(0, pre), "same");
        push(out, a.slice(pre, a.length - suf), "removed");
        push(out, b.slice(pre, b.length - suf), next.kind);
        push(out, a.slice(a.length - suf), "same");
        k++;
        continue;
      }
    }
    push(out, cur.text, cur.kind);
  }
  return out;
}

const exact = (x: string, y: string) => (x === y ? 1 : 0);

// The inline diff of one text across HEAD, the index, and the working tree.
// A missing version is the empty string.
export function diffText(head: string, index: string, work: string): Segment[] {
  const h = tokenize(head);
  const i = tokenize(index);
  const w = tokenize(work);
  const out: Segment[] = [];
  for (const row of mergeThree(h, i, w, exact)) {
    if (row.i === undefined) {
      if (row.h !== undefined) push(out, h[row.h], "removed");
      else push(out, w[row.w as number], "unstaged");
    } else if (row.h !== undefined) {
      push(out, h[row.h], row.w === undefined ? "removed" : "same");
    } else if (row.w !== undefined) {
      push(out, i[row.i], "staged");
    }
    // else: staged and then removed from the working tree: not shown.
  }
  return refineWords(out);
}

// Similarity of two criteria in (0, 1]: 1 when equal, otherwise the shared
// share of their words, or 0 when less than half the words are shared.
export function similarity(x: string, y: string): number {
  if (x === y) return 1;
  const words = (s: string) => tokenize(s).filter((t) => WORD.test(t));
  const a = words(x);
  const b = words(y);
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  const dice = (2 * shared) / (a.length + b.length);
  return dice >= 0.5 ? dice : 0;
}

// One row of a diffed list of criteria. `work` is the index of the criterion
// in the working-tree list (the key its follow-up note is stored under), and
// is undefined for rows that no longer exist there.
export type CriterionRow = { segments: Segment[]; work?: number };

// Diffs a criteria list across the three Git states, aligning criteria by
// text similarity rather than position. A criterion that was added in the
// index and removed again from the working tree is not shown.
export function diffCriteria(head: string[], index: string[], work: string[]): CriterionRow[] {
  const merged = mergeThree(head, index, work, similarity);
  // A criterion that only moved is a removal from HEAD plus an addition in
  // the working tree with identical text: show it once, unchanged, where it
  // is now.
  const dropped = new Set<number>();
  const unchanged = new Set<number>();
  for (const [a, from] of merged.entries()) {
    if (from.h === undefined || from.w !== undefined) continue;
    if (from.i !== undefined && index[from.i] !== head[from.h]) continue;
    const to = merged.findIndex(
      (r, b) =>
        !unchanged.has(b) &&
        r.h === undefined &&
        r.i === undefined &&
        r.w !== undefined &&
        work[r.w] === head[from.h as number],
    );
    if (to < 0) continue;
    dropped.add(a);
    unchanged.add(to);
  }
  const rows: CriterionRow[] = [];
  for (const [k, row] of merged.entries()) {
    if (dropped.has(k)) continue;
    const text = (list: string[], at?: number) => (at === undefined ? "" : list[at]);
    const segments = unchanged.has(k)
      ? diffText(work[row.w as number], work[row.w as number], work[row.w as number])
      : diffText(text(head, row.h), text(index, row.i), text(work, row.w));
    if (segments.length === 0) continue;
    rows.push({ segments, work: row.w });
  }
  return rows;
}
