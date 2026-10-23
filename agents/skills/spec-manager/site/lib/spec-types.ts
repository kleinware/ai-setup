// Shared types for the spec store data, used by both server and client code.

export type SpecEntry = {
  id: string;
  description: string;
  motivation: string;
  acceptance_criteria: string | string[];
  status?: string;
  meta?: unknown;
  // Set on a spec that is in HEAD but gone from the working tree: the entry
  // holds its HEAD content and is shown read-only.
  deleted?: boolean;
};

// A spec's content at one Git state (HEAD or the index), as the inline diff
// compares it.
export type SpecVersion = {
  description: string;
  motivation: string;
  acceptance_criteria: string[];
  status?: string;
  change?: SpecChange;
};

// The HEAD and index versions of a spec that differs from HEAD; a version is
// missing where the spec does not exist in that state.
export type GitVersions = { head?: SpecVersion; index?: SpecVersion };

// Saved note text for one spec, or for the spec's proposed change. Spec
// criteria are keyed by index ("0", "1", ...); change criteria by their
// meta.change.acceptance_criteria key ("0", "new1", ...).
export type NoteSet = {
  description?: string;
  motivation?: string;
  acceptance_criteria?: Record<string, string>;
};

export type FollowUpItem = NoteSet & {
  id: string;
  change?: NoteSet;
};

// The proposed change a spec carries in meta.change, limited to the fields
// the spec manager supports.
export type SpecChange = {
  description?: string;
  motivation?: string;
  acceptance_criteria?: Record<string, string | false>;
  change_status?: string;
};

export function specChange(spec: SpecEntry): SpecChange | undefined {
  const meta = spec.meta;
  if (meta == null || typeof meta !== "object") return undefined;
  const raw = (meta as { change?: unknown }).change;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const criteria = c.acceptance_criteria;
  return {
    description: typeof c.description === "string" ? c.description : undefined,
    motivation: typeof c.motivation === "string" ? c.motivation : undefined,
    acceptance_criteria:
      criteria != null && typeof criteria === "object" && !Array.isArray(criteria)
        ? Object.fromEntries(
            Object.entries(criteria as Record<string, unknown>).map(([k, v]) => [
              String(k),
              v === false ? false : String(v),
            ]),
          )
        : undefined,
    change_status: typeof c.change_status === "string" ? c.change_status : undefined,
  };
}

// Criterion keys of a change in display order: numeric indexes ascending,
// then newN keys in key order.
export function changeCriterionKeys(change: SpecChange): string[] {
  const keys = Object.keys(change.acceptance_criteria ?? {});
  const rank = (k: string) => (k.startsWith("new") ? 1 : 0);
  const num = (k: string) => Number.parseInt(k.replace(/^new/, ""), 10);
  return keys.sort((a, b) => rank(a) - rank(b) || num(a) - num(b));
}

export type StoreConfig = {
  status: false | Array<{ name: string; description: string }>;
  taxonomy:
    | { layers: false; structure?: undefined }
    | { layers: string[]; structure?: Record<string, unknown> }
    | undefined;
};

export type StoreData = {
  root: string;
  specDir: string;
  // Folder name of the main git project, and its checked-out branch (null
  // when the root is not in a git repository).
  repoName: string;
  branch: string | null;
  config: StoreConfig | null;
  specs: SpecEntry[];
  followUps: FollowUpItem[];
  // Whether the project root is in a git repository.
  inGit: boolean;
  // For every spec whose entry differs from HEAD (staged, unstaged, in an
  // untracked file, or deleted), its HEAD and index versions. Empty when the
  // project root is not in a git repository.
  gitDiffs: Record<string, GitVersions>;
  // Ids of the gitDiffs, sorted.
  dirtyIds: string[];
  errors: string[];
};
