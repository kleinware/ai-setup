import { expect, test } from "bun:test";

import { diffCriteria, diffText, type Segment } from "../lib/text-diff";

// Unit tests for the inline diff behind the git-diff specs
// (tooling_spec-manager_site-diff_git-diff-*).

const marked = (segs: Segment[]) =>
  segs.filter((s) => s.kind !== "same").map((s) => `${s.kind}:${s.text}`);

// Invariants of every diff: the unmarked, staged, and unstaged text read as
// the working tree (or the index where the working tree dropped it), and the
// unmarked and removed text read as HEAD.
const text = (segs: Segment[], kinds: Segment["kind"][]) =>
  segs
    .filter((s) => kinds.includes(s.kind))
    .map((s) => s.text)
    .join("");

test("T1 [git-diff-inline] identical text has no marked segments", () => {
  expect(diffText("a b c", "a b c", "a b c")).toEqual([{ text: "a b c", kind: "same" }]);
});

test("T2 [git-diff-inline] working-tree-only change: HEAD text red, new text yellow, no green", () => {
  const segs = diffText("the quick fox", "the quick fox", "the slow fox");
  expect(marked(segs)).toEqual(["removed:quick", "unstaged:slow"]);
});

test("T3 [git-diff-inline] index-only change: HEAD text red, new text green, no yellow", () => {
  const segs = diffText("the quick fox", "the slow fox", "the slow fox");
  expect(marked(segs)).toEqual(["removed:quick", "staged:slow"]);
});

test("T4 [git-diff-layering] staged additions are green, unstaged additions on top are yellow", () => {
  const segs = diffText("one", "one two", "one two three");
  expect(marked(segs)).toEqual(["staged: two", "unstaged: three"]);
});

test("T5 [git-diff-layering] text staged and then removed from the working tree is not shown", () => {
  const segs = diffText("one", "one two", "one");
  expect(segs).toEqual([{ text: "one", kind: "same" }]);
});

test("T6 [git-diff-layering] HEAD text removed by the staged or the unstaged edit is red", () => {
  for (const segs of [diffText("a b c", "a c", "a c"), diffText("a b c", "a b c", "a c")]) {
    expect(segs.filter((s) => s.kind === "removed").map((s) => s.text.trim())).toEqual(["b"]);
    expect(text(segs, ["same", "removed"])).toBe("a b c");
    expect(text(segs, ["same", "staged", "unstaged"])).toBe("a c");
  }
});

test("T7 [git-diff-granularity] appending a word marks only that word", () => {
  const segs = diffText("It does the thing.", "It does the thing.", "It does the thing. Really.");
  expect(marked(segs)).toEqual(["unstaged: Really."]);
});

test("T8 [git-diff-granularity] run -> runs marks only the s", () => {
  expect(diffText("it will run", "it will run", "it will runs")).toEqual([
    { text: "it will run", kind: "same" },
    { text: "s", kind: "unstaged" },
  ]);
});

test("T9 [git-diff-granularity] replacing a word with an unrelated word marks both whole words", () => {
  expect(marked(diffText("a cat sat", "a cat sat", "a dog sat"))).toEqual([
    "removed:cat",
    "unstaged:dog",
  ]);
});

test("T10 [git-diff-granularity] punctuation changes are marked individually", () => {
  expect(marked(diffText("done.", "done.", "done!"))).toEqual(["removed:.", "unstaged:!"]);
});

test("T11 [git-diff-criteria-matching] inserting a criterion in the middle marks only that criterion", () => {
  const head = ["first thing works", "second thing works"];
  const rows = diffCriteria(head, head, ["first thing works", "brand new check", "second thing works"]);
  expect(rows.map((r) => marked(r.segments))).toEqual([[], ["unstaged:brand new check"], []]);
  expect(rows.map((r) => r.work)).toEqual([0, 1, 2]);
});

test("T12 [git-diff-criteria-matching] deleting a criterion shows it red in place, without a working-tree index", () => {
  const head = ["first thing works", "second thing works", "third thing works"];
  const rows = diffCriteria(head, head, ["first thing works", "third thing works"]);
  expect(rows.map((r) => marked(r.segments))).toEqual([[], ["removed:second thing works"], []]);
  expect(rows.map((r) => r.work)).toEqual([0, undefined, 1]);
});

test("T13 [git-diff-criteria-matching] editing a criterion shows an inline word diff for just that one", () => {
  const head = ["the command prints the usage text", "unrelated criterion"];
  const rows = diffCriteria(head, head, ["the command prints the full usage text", "unrelated criterion"]);
  expect(marked(rows[0].segments)).toEqual(["unstaged:full "]);
  expect(marked(rows[1].segments)).toEqual([]);
  expect(rows).toHaveLength(2);
});

test("T14 [git-diff-criteria-matching] a reordered identical criterion shows no highlights", () => {
  const head = ["alpha criterion here", "beta criterion there"];
  const rows = diffCriteria(head, head, ["beta criterion there", "alpha criterion here"]);
  expect(rows.map((r) => marked(r.segments))).toEqual([[], []]);
  expect(rows).toHaveLength(2);
});
