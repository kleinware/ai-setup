"use client";

// Spec viewer/editor site: renders every spec from the store, grouped by
// taxonomy, with live updates pushed over /api/events, status editing via
// the /api/specs/status endpoint, and auto-saved follow-up notes via the
// /api/follow-ups endpoint.

import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Item, ItemTitle } from "@/components/ui/item";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";
import {
  type FollowUpItem,
  type GitVersions,
  type SpecChange,
  type SpecEntry,
  type StoreData,
  changeCriterionKeys,
  specChange,
} from "@/lib/spec-types";
import { type Segment, type SegmentKind, diffCriteria, diffText } from "@/lib/text-diff";

type StatusOption = { name: string; description: string };

// Background of a diffed text segment: removed from HEAD is very light red,
// unstaged additions very light yellow, staged additions very light green;
// unchanged text keeps the normal background.
const DIFF_CLASS: Record<SegmentKind, string> = {
  same: "",
  removed: "bg-red-500/15",
  unstaged: "bg-yellow-400/25",
  staged: "bg-green-500/20",
};

function DiffText({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} data-diff={seg.kind} className={DIFF_CLASS[seg.kind]}>
          {seg.text}
        </span>
      ))}
    </>
  );
}

function DiffLegend() {
  const items: Array<[SegmentKind, string]> = [
    ["removed", "removed"],
    ["unstaged", "unstaged"],
    ["staged", "staged"],
  ];
  return (
    <div data-testid="diff-legend" className="flex items-center gap-3 text-xs text-muted-foreground">
      {items.map(([kind, label]) => (
        <span key={kind} className="flex items-center gap-1">
          <span
            data-testid={`diff-legend-${kind}`}
            className={cn("inline-block size-3 rounded-sm border", DIFF_CLASS[kind])}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

type GroupNode = {
  term: string;
  children: Map<string, GroupNode>;
  specs: SpecEntry[];
};

function buildTree(specs: SpecEntry[], layers: string[]): GroupNode {
  const root: GroupNode = { term: "", children: new Map(), specs: [] };
  for (const spec of specs) {
    const parts = spec.id.split("_");
    const terms = parts.slice(0, layers.length);
    let node = root;
    for (const term of terms) {
      let child = node.children.get(term);
      if (!child) {
        child = { term, children: new Map(), specs: [] };
        node.children.set(term, child);
      }
      node = child;
    }
    node.specs.push(spec);
  }
  return root;
}

// A spec matches the active filters when it matches every one of them:
// status (when set), taxonomy branch (when set), text query (when set), and
// having feedback (when set), having a proposed change (when set), and being
// dirty in the Git workspace (when set).
type SpecFilter = (spec: SpecEntry) => boolean;

function makeFilter(
  status: string,
  taxonomy: string,
  query: string,
  feedbackOnly: boolean,
  feedbackIds: Set<string>,
  changeOnly: boolean,
  dirtyOnly: boolean,
  dirtyIds: Set<string>,
): SpecFilter {
  const needle = query.trim().toLowerCase();
  return (spec) => {
    if (feedbackOnly && !feedbackIds.has(spec.id)) return false;
    if (changeOnly && !specChange(spec)) return false;
    if (dirtyOnly && !dirtyIds.has(spec.id)) return false;
    if (status !== "" && spec.status !== status) {
      // A proposed change is pending or approved like a spec, so those two
      // filters also keep specs whose change has that change_status.
      const changeStatus = specChange(spec)?.change_status;
      if (!(changeStatus !== undefined && changeStatus === status)) return false;
    }
    if (taxonomy !== "") {
      const prefix = taxonomy.split("/").join("_") + "_";
      if (!spec.id.startsWith(prefix)) return false;
    }
    if (needle !== "") {
      const fields: string[] = [
        spec.id,
        spec.description,
        spec.motivation,
        ...criteriaList(spec.acceptance_criteria),
      ];
      const change = specChange(spec);
      if (change) {
        fields.push(change.description ?? "", change.motivation ?? "");
        for (const v of Object.values(change.acceptance_criteria ?? {})) {
          if (typeof v === "string") fields.push(v);
        }
      }
      if (!fields.some((f) => f.toLowerCase().includes(needle))) return false;
    }
    return true;
  };
}

// Feedback whose spec no longer exists has no spec to filter, so it is kept
// by the filters that can apply to an id alone: taxonomy branch and text
// query. Status, proposed-change, and dirty filters hide it.
function makeOrphanFilter(
  status: string,
  taxonomy: string,
  query: string,
  changeOnly: boolean,
  dirtyOnly: boolean,
): (id: string) => boolean {
  const needle = query.trim().toLowerCase();
  return (id) => {
    if (status !== "" || changeOnly || dirtyOnly) return false;
    if (taxonomy !== "" && !id.startsWith(taxonomy.split("/").join("_") + "_")) return false;
    return needle === "" || id.toLowerCase().includes(needle);
  };
}

// Every taxonomy branch in the store: each area, and each deeper
// component/section branch present in the configured structure.
function structureBranches(
  structure: Record<string, unknown>,
  prefix: string,
): string[] {
  const out: string[] = [];
  for (const [term, value] of Object.entries(structure)) {
    const path = prefix === "" ? term : `${prefix}/${term}`;
    out.push(path);
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        // leaf list: each term is a branch of the final layer
        for (const item of value) out.push(`${path}/${String(item)}`);
      } else {
        out.push(...structureBranches(value as Record<string, unknown>, path));
      }
    }
  }
  return out;
}

function collectTaxonomyOptions(data: StoreData): string[] {
  const taxonomy = data.config?.taxonomy;
  let branches: string[] = [];
  if (taxonomy && Array.isArray(taxonomy.layers)) {
    if (taxonomy.structure) {
      branches = structureBranches(taxonomy.structure, "");
    } else {
      // No declared structure: derive branches from the spec ids themselves.
      const set = new Set<string>();
      for (const spec of data.specs) {
        const parts = spec.id.split("_").slice(0, taxonomy.layers.length);
        for (let i = 1; i <= parts.length; i++) {
          set.add(parts.slice(0, i).join("/"));
        }
      }
      branches = [...set];
    }
  }
  return branches.sort();
}

function countVisible(node: GroupNode, filter: SpecFilter): number {
  let count = node.specs.filter(filter).length;
  for (const child of node.children.values()) count += countVisible(child, filter);
  return count;
}

function criteriaList(criteria: string | string[]): string[] {
  return Array.isArray(criteria) ? criteria : [criteria];
}

type NoteField = "description" | "motivation" | "criterion";

type FieldDef = {
  field: NoteField;
  index?: number;
  // Set for notes on the spec's proposed change (meta.change): the
  // criterion is addressed by its change key ("0", "new1", ...) instead.
  target?: "change";
  criterionKey?: string;
  key: string;
  server: string;
  // Set when the element this note was written for no longer exists (the
  // criterion index is out of range, the proposed change or its field is
  // gone, or the whole spec is gone): the label to show above the note, and
  // the ids the note's textarea and controls use.
  orphan?: { label: string; testId: string; suffix: string };
};

type FieldState = { draft: string; saved: string };

type IndicatorState = "pending" | "saved" | "idle";

function NoteIndicator({
  testId,
  state,
}: {
  testId: string;
  state: IndicatorState;
}) {
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={cn(
        "mt-1.5 flex shrink-0 items-center",
        state === "pending" && "size-2 rounded-full bg-yellow-400",
        state === "saved" && "text-green-600",
      )}
    >
      {state === "saved" ? <RiCheckLine /> : null}
    </span>
  );
}

// A textarea that grows vertically with its content (the base min-height is
// kept), so multi-line text stays fully visible. Enter is a plain newline;
// saving happens on blur or after 5s of inactivity via the parent's draft
// machinery.
function AutoGrowTextarea(props: ComponentProps<"textarea">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { value, ...rest } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <Textarea ref={ref} value={value} {...rest} />;
}

// Whether a saved follow-up item still carries any note text.
function hasFeedback(item: FollowUpItem): boolean {
  return (
    !!item.description ||
    !!item.motivation ||
    Object.values(item.acceptance_criteria ?? {}).some((v) => v !== "") ||
    (item.change !== undefined && hasFeedback({ id: item.id, ...item.change }))
  );
}

// The spec's proposed change (meta.change), shown like a spec of its own:
// description and motivation replacements and the criteria deltas, each with
// its own feedback note.
function ChangeSection({
  specId,
  change,
  versions,
  noteField,
}: {
  specId: string;
  change: SpecChange;
  // Set when the spec differs from HEAD: the change is then diffed against
  // its HEAD and index versions.
  versions?: GitVersions;
  noteField: (key: string, textareaId: string, suffix: string) => ReactNode;
}) {
  const head = versions?.head?.change;
  const index = versions?.index?.change;
  const inline = (text: string, pick: (c: SpecChange | undefined) => string | undefined) =>
    versions ? (
      <DiffText segments={diffText(pick(head) ?? "", pick(index) ?? "", text)} />
    ) : (
      text
    );
  const criteria = change.acceptance_criteria ?? {};

  // change_status editing, like the spec status: optimistic local update,
  // reverted on a failed save; store updates adopt the server value.
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  useEffect(() => {
    setLocalStatus(null);
  }, [change]);
  const changeStatus = localStatus ?? change.change_status;
  const handleStatusChange = (next: string) => {
    if (next === changeStatus) return;
    setLocalStatus(next);
    fetch("/api/specs/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: specId, status: next, target: "change" }),
    })
      .then((res) => {
        if (!res.ok) setLocalStatus(null);
      })
      .catch(() => {
        setLocalStatus(null);
      });
  };
  return (
    <div
      data-testid={`spec-change-${specId}`}
      className="mt-3 space-y-2 rounded-md border border-dashed p-3"
    >
      <div
        data-testid={`spec-change-status-area-${specId}`}
        className="flex flex-wrap items-center gap-3"
      >
        <span className="text-sm font-medium">Proposed change</span>
        <RadioGroup
          data-testid={`change-status-radio-${specId}`}
          value={changeStatus}
          onValueChange={(v: string) => handleStatusChange(v)}
          className="flex w-fit items-center gap-3"
        >
          {["pending", "approved"].map((name) => (
            <label
              key={name}
              htmlFor={`change-status-opt-${specId}-${name}`}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <RadioGroupItem
                id={`change-status-opt-${specId}-${name}`}
                data-testid={`change-status-option-${specId}-${name}`}
                value={name}
              />
              {name}
            </label>
          ))}
        </RadioGroup>
        {changeStatus ? (
          <Badge variant="secondary" data-testid={`spec-change-status-${specId}`}>
            {changeStatus}
          </Badge>
        ) : null}
      </div>
      {change.description !== undefined ? (
        <>
          <p data-testid={`spec-change-description-${specId}`} className="text-sm">
            {inline(change.description, (c) => c?.description)}
          </p>
          {noteField(
            "change-description",
            `follow-up-change-desc-${specId}`,
            `change-desc-${specId}`,
          )}
        </>
      ) : null}
      {change.motivation !== undefined ? (
        <>
          <p
            data-testid={`spec-change-motivation-${specId}`}
            className="text-sm text-muted-foreground"
          >
            <span className="font-medium text-foreground">Why:</span>{" "}
            {inline(change.motivation, (c) => c?.motivation)}
          </p>
          {noteField(
            "change-motivation",
            `follow-up-change-motivation-${specId}`,
            `change-motivation-${specId}`,
          )}
        </>
      ) : null}
      {changeCriterionKeys(change).length > 0 ? (
        <div data-testid={`spec-change-criteria-${specId}`}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Acceptance criteria changes
          </p>
          {changeCriterionKeys(change).map((k) => {
            const v = criteria[k];
            const label = k.startsWith("new") ? "add" : `#${k}`;
            return (
              <div key={k} className="space-y-1">
                <ul className="ml-4 list-disc text-sm">
                  <li>
                    <span className="mr-1 font-mono text-xs text-muted-foreground">
                      {label}
                    </span>
                    {v === false ? (
                      <em>remove criterion</em>
                    ) : (
                      inline(v, (c) => {
                        const old = c?.acceptance_criteria?.[k];
                        return typeof old === "string" ? old : undefined;
                      })
                    )}
                  </li>
                </ul>
                {noteField(
                  `change-criterion-${k}`,
                  `follow-up-change-criterion-${specId}-${k}`,
                  `change-criterion-${specId}-${k}`,
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// A spec's row. `spec` is undefined for feedback whose spec id no longer
// exists: the row then shows just the id and the orphaned feedback notes.
function SpecRow({
  id,
  spec,
  note,
  statuses,
  versions,
}: {
  id: string;
  spec?: SpecEntry;
  note?: FollowUpItem;
  statuses: StatusOption[];
  // Set when the spec differs from HEAD: its HEAD and index versions, which
  // its text is diffed against inline.
  versions?: GitVersions;
}) {
  const change = useMemo(() => (spec ? specChange(spec) : undefined), [spec]);
  const fieldDefs = useMemo<FieldDef[]>(() => {
    const defs: FieldDef[] = [
      {
        field: "description",
        key: "description",
        server: note?.description ?? "",
        orphan: spec
          ? undefined
          : { label: "Description", testId: `follow-up-desc-${id}`, suffix: `desc-${id}` },
      },
      {
        field: "motivation",
        key: "motivation",
        server: note?.motivation ?? "",
        orphan: spec
          ? undefined
          : {
              label: "Why",
              testId: `follow-up-motivation-${id}`,
              suffix: `motivation-${id}`,
            },
      },
    ];
    const criteriaCount = spec ? criteriaList(spec.acceptance_criteria).length : 0;
    for (let i = 0; i < criteriaCount; i++) {
      defs.push({
        field: "criterion",
        index: i,
        key: `criterion-${i}`,
        server: note?.acceptance_criteria?.[String(i)] ?? "",
      });
    }
    // Criterion feedback past the end of the list (or for a missing spec).
    for (const [k, v] of Object.entries(note?.acceptance_criteria ?? {})) {
      if (!/^\d+$/.test(k) || Number(k) < criteriaCount) continue;
      defs.push({
        field: "criterion",
        index: Number(k),
        key: `criterion-${k}`,
        server: v,
        orphan: {
          label: `Acceptance criterion #${k}`,
          testId: `follow-up-criterion-${id}-${k}`,
          suffix: `criterion-${id}-${k}`,
        },
      });
    }
    defs.push(
      {
        field: "description",
        target: "change",
        key: "change-description",
        server: note?.change?.description ?? "",
        orphan:
          change?.description !== undefined
            ? undefined
            : {
                label: "Proposed change description",
                testId: `follow-up-change-desc-${id}`,
                suffix: `change-desc-${id}`,
              },
      },
      {
        field: "motivation",
        target: "change",
        key: "change-motivation",
        server: note?.change?.motivation ?? "",
        orphan:
          change?.motivation !== undefined
            ? undefined
            : {
                label: "Proposed change why",
                testId: `follow-up-change-motivation-${id}`,
                suffix: `change-motivation-${id}`,
              },
      },
    );
    const liveKeys = change ? changeCriterionKeys(change) : [];
    for (const k of liveKeys) {
      defs.push({
        field: "criterion",
        target: "change",
        criterionKey: k,
        key: `change-criterion-${k}`,
        server: note?.change?.acceptance_criteria?.[k] ?? "",
      });
    }
    for (const [k, v] of Object.entries(note?.change?.acceptance_criteria ?? {})) {
      if (liveKeys.includes(k)) continue;
      defs.push({
        field: "criterion",
        target: "change",
        criterionKey: k,
        key: `change-criterion-${k}`,
        server: v,
        orphan: {
          label: `Proposed change criterion ${k.startsWith("new") ? "add" : `#${k}`}`,
          testId: `follow-up-change-criterion-${id}-${k}`,
          suffix: `change-criterion-${id}-${k}`,
        },
      });
    }
    return defs;
  }, [spec, id, note, change]);

  const [fields, setFields] = useState<Record<string, FieldState>>(() => {
    const init: Record<string, FieldState> = {};
    for (const def of fieldDefs) {
      init[def.key] = { draft: def.server, saved: def.server };
    }
    return init;
  });
  const fieldsRef = useRef(fields);
  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // On every store update (initial fetch and SSE refetch), adopt server
  // values for fields the user is not currently typing in; leave typing
  // fields (draft !== saved) untouched.
  useEffect(() => {
    setFields((prev) => {
      const next: Record<string, FieldState> = {};
      for (const def of fieldDefs) {
        const cur = prev[def.key];
        if (cur && cur.draft !== cur.saved) {
          next[def.key] = cur;
        } else {
          next[def.key] = { draft: def.server, saved: def.server };
          const t = timers.current[def.key];
          if (t) {
            clearTimeout(t);
            delete timers.current[def.key];
          }
        }
      }
      return next;
    });
  }, [fieldDefs]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const key of Object.keys(t)) {
        clearTimeout(t[key]);
        delete t[key];
      }
    };
  }, []);

  const clearTimer = (key: string) => {
    const t = timers.current[key];
    if (t) {
      clearTimeout(t);
      delete timers.current[key];
    }
  };

  const inFlight = useRef<Record<string, boolean>>({});

  const save = (key: string, value: string) => {
    const st = fieldsRef.current[key];
    const def = fieldDefs.find((d) => d.key === key);
    if (!st || !def || value === st.saved || inFlight.current[key]) return;
    inFlight.current[key] = true;
    const payload: Record<string, unknown> = {
      id,
      field: def.field,
      value,
    };
    if (def.index !== undefined) payload.index = def.index;
    if (def.target !== undefined) payload.target = def.target;
    if (def.criterionKey !== undefined) payload.key = def.criterionKey;
    fetch("/api/follow-ups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (res.ok) {
          setFields((f) => ({
            ...f,
            [key]: { ...f[key], saved: value },
          }));
        }
      })
      .finally(() => {
        inFlight.current[key] = false;
      });
  };

  const triggerSave = (key: string) => {
    const st = fieldsRef.current[key];
    if (!st) return;
    clearTimer(key);
    save(key, st.draft);
  };

  const setDraft = (key: string, draft: string) => {
    setFields((f) => {
      const cur = f[key] ?? { draft: "", saved: "" };
      return { ...f, [key]: { ...cur, draft } };
    });
    clearTimer(key);
    timers.current[key] = setTimeout(() => {
      clearTimer(key);
      triggerSave(key);
    }, 5000);
  };

  const indicator = (key: string): IndicatorState => {
    const st = fields[key];
    if (!st) return "idle";
    if (st.draft !== st.saved) return "pending";
    return st.saved !== "" ? "saved" : "idle";
  };

  const draftOf = (key: string) => fields[key]?.draft ?? "";

  // "Feedback addressed": empties the field and saves the empty value right
  // away, exactly as if the user had deleted the text.
  const markAddressed = (key: string) => {
    setDraft(key, "");
    save(key, "");
  };

  // One note field: the textarea (visually called out while it holds text),
  // its save indicator, and the "Feedback addressed" button with help text.
  const noteField = (key: string, textareaId: string, suffix: string) => (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <AutoGrowTextarea
          data-testid={textareaId}
          data-has-feedback={draftOf(key) !== ""}
          className={cn(
            "flex-1",
            draftOf(key) !== "" &&
              "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/40",
          )}
          value={draftOf(key)}
          onChange={(e) => setDraft(key, e.target.value)}
          onBlur={() => triggerSave(key)}
        />
        <NoteIndicator
          testId={`follow-up-indicator-${suffix}`}
          state={indicator(key)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid={`follow-up-addressed-${suffix}`}
          disabled={draftOf(key) === ""}
          onClick={() => markAddressed(key)}
        >
          Feedback addressed
        </Button>
        <span className="text-xs text-muted-foreground">
          Clears this feedback note and removes it from the follow-up file.
        </span>
      </div>
    </div>
  );

  // Status editing: optimistic local update, reverted on a failed save;
  // store updates (SSE refetches) adopt the server status.
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  useEffect(() => {
    setLocalStatus(null);
  }, [spec]);
  const status = localStatus ?? spec?.status;

  const handleStatusChange = (next: string) => {
    if (next === status) return;
    setLocalStatus(next);
    fetch("/api/specs/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: next }),
    })
      .then((res) => {
        if (!res.ok) setLocalStatus(null);
      })
      .catch(() => {
        setLocalStatus(null);
      });
  };

  // Click-to-copy for the spec id, with a brief toast at the cursor.
  const [copyToast, setCopyToast] = useState<{ x: number; y: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  const copyId = (e: React.MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopyToast({ x, y });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setCopyToast(null), 1500);
      })
      .catch(() => {});
  };

  const criteria = useMemo(
    () => (spec ? criteriaList(spec.acceptance_criteria) : []),
    [spec],
  );

  // Inline diff against HEAD and the index. A deleted spec holds its HEAD
  // content, so against an empty working tree every word is removed.
  const diff = useMemo(() => {
    if (!spec || !versions) return undefined;
    const deleted = spec.deleted === true;
    const text = (pick: (v: NonNullable<GitVersions["head"]>) => string, work: string) =>
      diffText(
        versions.head ? pick(versions.head) : "",
        versions.index ? pick(versions.index) : "",
        deleted ? "" : work,
      );
    const rows = deleted
      ? criteria.map((c, i) => ({ segments: [{ text: c, kind: "removed" as const }], work: i }))
      : diffCriteria(
          versions.head?.acceptance_criteria ?? [],
          versions.index?.acceptance_criteria ?? [],
          criteria,
        );
    return {
      description: text((v) => v.description, spec.description),
      motivation: text((v) => v.motivation, spec.motivation),
      criteria: rows,
    };
  }, [spec, versions, criteria]);

  // The criteria rows to show: diffed against Git when the spec differs from
  // HEAD, otherwise the plain list. `work` is the criterion's index in the
  // spec, the key its follow-up note is stored under; removed criteria have none.
  const criteriaRows: Array<{ text?: string; segments?: Segment[]; work?: number }> = diff
    ? diff.criteria
    : criteria.map((text, work) => ({ text, work }));

  // The status badge for a spec whose status differs from HEAD: the HEAD
  // status in red and the current status in the colour of where it lives.
  const statusDiff = (() => {
    if (!spec || !versions || spec.deleted) return undefined;
    const headStatus = versions.head?.status;
    if (versions.head && headStatus === spec.status) return undefined;
    const staged = versions.index?.status === spec.status;
    return { headStatus: versions.head ? headStatus : undefined, current: staged ? "staged" : "unstaged" };
  })();

  // Notes whose element is gone, shown (while they still hold text) with the
  // missing element's value as "<missing>"; for a missing spec only the
  // note labels are shown.
  const orphanDefs = fieldDefs.filter(
    (d) =>
      d.orphan &&
      (fields[d.key]?.draft !== "" || fields[d.key]?.saved !== "") &&
      fields[d.key] !== undefined,
  );

  return (
    <Item data-testid={`spec-row-${id}`} className="py-4">
      <Collapsible defaultOpen className="w-full">
        <div className="flex w-full items-center gap-2 px-1 py-1">
          <ArrowToggle testId={`spec-toggle-${id}`} label={`Toggle ${id}`} />
          <button
            type="button"
            data-testid={`spec-id-${id}`}
            title="Click to copy spec ID"
            onClick={copyId}
            className="cursor-pointer rounded-md px-1 text-left hover:bg-muted dark:hover:bg-muted/50"
          >
            <ItemTitle className="font-mono text-base">{id}</ItemTitle>
          </button>
        </div>
        {copyToast && (
          <div
            data-testid={`spec-copied-${id}`}
            role="status"
            style={{ left: copyToast.x + 12, top: copyToast.y + 12 }}
            className="pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md"
          >
            Copied {id}
          </div>
        )}
        <CollapsibleContent className="ml-4 space-y-2 border-l pl-3">
          {spec ? (
          <div
            data-testid={`spec-status-area-${id}`}
            className="flex flex-wrap items-center gap-3 px-3 pt-1"
          >
            <span className="shrink-0 text-sm text-muted-foreground">Status</span>
            {statuses.length > 0 && !spec.deleted ? (
              <RadioGroup
                data-testid={`status-radio-${id}`}
                value={status}
                onValueChange={(v: string) => handleStatusChange(v)}
                className="flex w-fit items-center gap-3"
              >
                {statuses.map((s) => (
                  <label
                    key={s.name}
                    htmlFor={`status-opt-${id}-${s.name}`}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <RadioGroupItem
                      id={`status-opt-${id}-${s.name}`}
                      data-testid={`status-option-${id}-${s.name}`}
                      value={s.name}
                    />
                    {s.name}
                  </label>
                ))}
              </RadioGroup>
            ) : null}
            {statusDiff?.headStatus ? (
              <Badge
                variant="secondary"
                data-testid={`spec-status-head-${id}`}
                data-diff="removed"
                className={DIFF_CLASS.removed}
              >
                {statusDiff.headStatus}
              </Badge>
            ) : null}
            {status ? (
              <Badge
                variant="secondary"
                data-testid={`spec-status-${id}`}
                data-diff={spec.deleted ? "removed" : statusDiff?.current}
                className={
                  spec.deleted
                    ? DIFF_CLASS.removed
                    : statusDiff
                      ? DIFF_CLASS[statusDiff.current as SegmentKind]
                      : undefined
                }
              >
                {status}
              </Badge>
            ) : null}
          </div>
          ) : null}
          <div
            data-testid={`follow-up-${id}`}
            className="space-y-2 px-3 pb-1"
          >
            {spec ? (
              <>
            <p data-testid={`spec-description-${id}`} className="text-sm">
              {diff ? <DiffText segments={diff.description} /> : spec.description}
            </p>
            {noteField("description", `follow-up-desc-${id}`, `desc-${id}`)}
            <p
              data-testid={`spec-motivation-${id}`}
              className="text-sm text-muted-foreground"
            >
              <span className="font-medium text-foreground">Why:</span>{" "}
              {diff ? <DiffText segments={diff.motivation} /> : spec.motivation}
            </p>
            {noteField("motivation", `follow-up-motivation-${id}`, `motivation-${id}`)}
            <div data-testid={`spec-criteria-${id}`}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Acceptance criteria
              </p>
              {criteriaRows.map((row, k) => (
                <div key={k} className="space-y-1">
                  <ul className="ml-4 list-disc text-sm">
                    <li>{row.segments ? <DiffText segments={row.segments} /> : row.text}</li>
                  </ul>
                  {row.work !== undefined
                    ? noteField(
                        `criterion-${row.work}`,
                        `follow-up-criterion-${id}-${row.work}`,
                        `criterion-${id}-${row.work}`,
                      )
                    : null}
                </div>
              ))}
            </div>
            {change ? (
              <ChangeSection
                specId={id}
                change={change}
                versions={spec?.deleted ? undefined : versions}
                noteField={noteField}
              />
            ) : null}
              </>
            ) : (
              <p
                data-testid={`spec-missing-${id}`}
                className="text-sm text-muted-foreground"
              >
                This spec no longer exists.
              </p>
            )}
            {orphanDefs.map((d) => (
              <div
                key={d.key}
                data-testid={`orphan-feedback-${d.orphan!.suffix}`}
                className="space-y-1"
              >
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{d.orphan!.label}</span>
                  {spec ? <>: {"<missing>"}</> : null}
                </p>
                {noteField(d.key, d.orphan!.testId, d.orphan!.suffix)}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

// The one expand/collapse arrow, used for both taxonomy groups and spec rows.
function ArrowToggle({ testId, label }: { testId: string; label: string }) {
  return (
    <CollapsibleTrigger
      data-testid={testId}
      aria-label={label}
      className="group flex shrink-0 cursor-pointer items-center rounded-md p-1 hover:bg-muted dark:hover:bg-muted/50"
    >
      <RiArrowDownSLine className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
    </CollapsibleTrigger>
  );
}

function LayerGroup({
  node,
  depth,
  layers,
  pathKey,
  followUpsById,
  statuses,
  gitDiffs,
  filter,
}: {
  node: GroupNode;
  depth: number;
  layers: string[];
  pathKey: string;
  followUpsById: Map<string, FollowUpItem>;
  statuses: StatusOption[];
  gitDiffs: Record<string, GitVersions>;
  filter: SpecFilter;
}) {
  const visibleCount = countVisible(node, filter);
  if (visibleCount === 0) return null;
  const layerName = layers[depth] ?? "";
  const terms = [...node.children.keys()]
    .filter((term) => countVisible(node.children.get(term)!, filter) > 0)
    .sort();
  const visibleSpecs = node.specs.filter(filter);
  return (
    <Collapsible
      defaultOpen
      data-testid={`group-${pathKey}`}
      className="rounded-lg"
    >
      <div className="flex w-full items-center gap-2 px-1 py-1">
        <ArrowToggle
          testId={`group-${pathKey}-trigger`}
          label={`Toggle ${node.term}`}
        />
        <span className="text-sm font-medium">
          <span className="mr-2 text-xs text-muted-foreground">{layerName}</span>
          {node.term}
        </span>
        <Badge variant="outline" className="ml-auto">
          {visibleCount}
        </Badge>
      </div>
      <CollapsibleContent>
        <div className="ml-4 space-y-2 border-l pl-3">
          {terms.map((term) => (
            <LayerGroup
              key={term}
              node={node.children.get(term)!}
              depth={depth + 1}
              layers={layers}
              pathKey={`${pathKey}-${term}`}
              followUpsById={followUpsById}
              statuses={statuses}
              gitDiffs={gitDiffs}
              filter={filter}
            />
          ))}
          {visibleSpecs.map((spec) => (
            <SpecRow
              key={spec.id}
              id={spec.id}
              spec={spec}
              note={followUpsById.get(spec.id)}
              statuses={statuses}
              versions={gitDiffs[spec.id]}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SpecTree({
  data,
  filter,
  orphanFilter,
}: {
  data: StoreData;
  filter: SpecFilter;
  orphanFilter: (id: string) => boolean;
}) {
  const followUpsById = useMemo(
    () => new Map(data.followUps.map((f) => [f.id, f])),
    [data.followUps],
  );
  const layers = data.config?.taxonomy?.layers;
  const statuses = Array.isArray(data.config?.status)
    ? data.config.status
    : [];
  const orphans = useMemo(() => {
    const ids = new Set(data.specs.map((s) => s.id));
    return data.followUps.filter(
      (f) => !ids.has(f.id) && hasFeedback(f) && orphanFilter(f.id),
    );
  }, [data.specs, data.followUps, orphanFilter]);
  const orphanRows = orphans.length > 0 ? (
    <div data-testid="orphan-feedback" className="space-y-2">
      {orphans.map((f) => (
        <SpecRow key={f.id} id={f.id} note={f} statuses={statuses} />
      ))}
    </div>
  ) : null;

  if (Array.isArray(layers)) {
    const root = buildTree(data.specs, layers);
    const terms = [...root.children.keys()]
      .filter((term) => countVisible(root.children.get(term)!, filter) > 0)
      .sort();
    const visibleRootSpecs = root.specs.filter(filter);
    const visibleTotal =
      terms.reduce((sum, term) => sum + countVisible(root.children.get(term)!, filter), 0) +
      visibleRootSpecs.length;
    if (visibleTotal === 0 && orphans.length === 0) {
      return (
        <div data-testid="no-matches" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No specs match the active filters.
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {orphanRows}
        {terms.map((term) => (
          <LayerGroup
            key={term}
            node={root.children.get(term)!}
            depth={0}
            layers={layers}
            pathKey={term}
            followUpsById={followUpsById}
            statuses={statuses}
            gitDiffs={data.gitDiffs}
            filter={filter}
          />
        ))}
        {visibleRootSpecs.map((spec) => (
          <SpecRow
            key={spec.id}
            id={spec.id}
            spec={spec}
            note={followUpsById.get(spec.id)}
            statuses={statuses}
            versions={data.gitDiffs[spec.id]}
          />
        ))}
      </div>
    );
  }

  const visibleSpecs = data.specs.filter(filter);
  if (visibleSpecs.length === 0 && orphans.length === 0) {
    return (
      <div data-testid="no-matches" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No specs match the active filters.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {orphanRows}
      {visibleSpecs.map((spec) => (
        <SpecRow
          key={spec.id}
          id={spec.id}
          spec={spec}
          note={followUpsById.get(spec.id)}
          statuses={statuses}
          versions={data.gitDiffs[spec.id]}
        />
      ))}
    </div>
  );
}

// The taxonomy trigger's fixed chrome, in px: pl-2.5 (10) + gap-1.5 (6) +
// chevron icon size-4 (16) + pr-2 (8) + two 1px borders (2). The trigger is
// sized to the longest option label plus this chrome, so every option's
// label fits fully when selected.
const TRIGGER_CHROME_PX = 42;

function FilterBar({
  statuses,
  taxonomyOptions,
  statusFilter,
  taxonomyFilter,
  textQuery,
  feedbackOnly,
  changeOnly,
  dirtyOnly,
  onStatusFilter,
  onTaxonomyFilter,
  onTextQuery,
  onFeedbackOnly,
  onChangeOnly,
  onDirtyOnly,
}: {
  statuses: StatusOption[];
  taxonomyOptions: string[];
  statusFilter: string;
  taxonomyFilter: string;
  textQuery: string;
  feedbackOnly: boolean;
  changeOnly: boolean;
  dirtyOnly: boolean;
  onStatusFilter: (value: string) => void;
  onTaxonomyFilter: (value: string) => void;
  onTextQuery: (value: string) => void;
  onFeedbackOnly: (value: boolean) => void;
  onChangeOnly: (value: boolean) => void;
  onDirtyOnly: (value: boolean) => void;
}) {
  // The longest option label ("All taxonomy" plus every taxonomy branch);
  // its rendered width is measured in a hidden span in the same font as the
  // popup option labels, and drives the trigger's min-width.
  const longestLabel = useMemo(
    () =>
      ["All taxonomy", ...taxonomyOptions].reduce((a, b) =>
        b.length > a.length ? b : a,
      ),
    [taxonomyOptions],
  );
  const measureRef = useRef<HTMLSpanElement>(null);
  const [longestLabelWidth, setLongestLabelWidth] = useState(0);
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    setLongestLabelWidth(el.getBoundingClientRect().width);
  }, [longestLabel]);

  return (
    <div
      data-testid="filter-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 p-2.5"
    >
      {statuses.length > 0 ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <Select
            value={statusFilter}
            onValueChange={(v: string | null) => onStatusFilter(v ?? "")}
          >
            <SelectTrigger data-testid="filter-status" className="h-8 min-w-32">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" data-testid="filter-status-option-all">
                All statuses
              </SelectItem>
              {statuses.map((s) => (
                <SelectItem
                  key={s.name}
                  value={s.name}
                  data-testid={`filter-status-option-${s.name}`}
                >
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {taxonomyOptions.length > 0 ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Taxonomy</span>
          <Select
            value={taxonomyFilter}
            onValueChange={(v: string | null) => onTaxonomyFilter(v ?? "")}
          >
            <SelectTrigger
              data-testid="filter-taxonomy"
              className="h-8 min-w-32"
              style={{ minWidth: longestLabelWidth + TRIGGER_CHROME_PX }}
            >
              <SelectValue placeholder="All taxonomy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" data-testid="filter-taxonomy-option-all">
                All taxonomy
              </SelectItem>
              {taxonomyOptions.map((path) => (
                <SelectItem
                  key={path}
                  value={path}
                  data-testid={`filter-taxonomy-option-${path.replaceAll("/", "-")}`}
                >
                  {path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span
            ref={measureRef}
            aria-hidden
            className="invisible absolute pointer-events-none whitespace-nowrap text-sm"
          >
            {longestLabel}
          </span>
        </label>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          data-testid="filter-feedback"
          type="checkbox"
          checked={feedbackOnly}
          onChange={(e) => onFeedbackOnly(e.target.checked)}
        />
        Has feedback
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          data-testid="filter-change"
          type="checkbox"
          checked={changeOnly}
          onChange={(e) => onChangeOnly(e.target.checked)}
        />
        Has proposed change
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          data-testid="filter-dirty"
          type="checkbox"
          checked={dirtyOnly}
          onChange={(e) => onDirtyOnly(e.target.checked)}
        />
        Pending git changes
      </label>
      <label className="flex min-w-56 flex-1 items-center gap-2 text-sm">
        <span className="text-muted-foreground">Text</span>
        <Input
          data-testid="filter-text"
          type="text"
          className="h-8 min-w-48 flex-1"
          placeholder="Search id, description, motivation, criteria"
          value={textQuery}
          onChange={(e) => onTextQuery(e.target.value)}
        />
      </label>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3" data-testid="loading">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export default function SpecViewer() {
  const [data, setData] = useState<StoreData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  // Active filters; "" / false means no filter for that control. All six apply
  // together (AND); clearing one restores the list subject to the rest.
  const [statusFilter, setStatusFilter] = useState("");
  const [taxonomyFilter, setTaxonomyFilter] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const [feedbackOnly, setFeedbackOnly] = useState(false);
  const [changeOnly, setChangeOnly] = useState(false);
  const [dirtyOnly, setDirtyOnly] = useState(false);

  useEffect(() => {
    let active = true;

    const refresh = () => {
      fetch("/api/specs", { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`GET /api/specs failed: ${res.status}`);
          return res.json() as Promise<StoreData>;
        })
        .then((d) => {
          if (active) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (active) setError(e instanceof Error ? e.message : String(e));
        });
    };

    refresh();
    const source = new EventSource("/api/events");
    source.onopen = () => {
      if (active) setLive(true);
    };
    source.onerror = () => {
      if (active) setLive(false);
    };
    source.onmessage = () => {
      refresh();
    };
    return () => {
      active = false;
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!data) return;
    const where = data.branch ? `${data.repoName} (${data.branch})` : data.repoName;
    document.title = `${where} \u00b7 Spec Manager`;
  }, [data?.repoName, data?.branch]);

  const config = data?.config;
  const statuses = config && Array.isArray(config.status) ? config.status : [];
  const taxonomyOptions = useMemo(
    () => (data ? collectTaxonomyOptions(data) : []),
    [data],
  );
  const feedbackIds = useMemo(
    () => new Set((data?.followUps ?? []).filter(hasFeedback).map((f) => f.id)),
    [data],
  );
  const orphanFilter = useMemo(
    () => makeOrphanFilter(statusFilter, taxonomyFilter, textQuery, changeOnly, dirtyOnly),
    [statusFilter, taxonomyFilter, textQuery, changeOnly, dirtyOnly],
  );
  const dirtyIds = useMemo(() => new Set(data?.dirtyIds ?? []), [data]);
  const filter = useMemo(
    () =>
      makeFilter(
        statusFilter,
        taxonomyFilter,
        textQuery,
        feedbackOnly,
        feedbackIds,
        changeOnly,
        dirtyOnly,
        dirtyIds,
      ),
    [
      statusFilter,
      taxonomyFilter,
      textQuery,
      feedbackOnly,
      feedbackIds,
      changeOnly,
      dirtyOnly,
      dirtyIds,
    ],
  );

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">Spec Manager</h1>
          <p className="text-sm text-muted-foreground">
            Specs from the local spec/ store, live-updated.
          </p>
        </div>
        <div
          data-testid="live-status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span
            className={`size-2 rounded-full ${live ? "bg-green-500" : "bg-muted-foreground/40"}`}
          />
          {live ? "live" : "connecting"}
        </div>
      </header>
      {data ? (
        <h2 data-testid="repo-banner" className="text-3xl font-semibold tracking-tight">
          {data.repoName}
          {data.branch ? ` (${data.branch})` : ""}
        </h2>
      ) : null}
      <Separator />
      {error ? (
        <div data-testid="error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : data ? (
        <>
          {data.errors.length > 0 ? (
            <div data-testid="store-errors" className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
              <p className="font-medium">Store problems:</p>
              <ul className="ml-4 list-disc">
                {data.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <FilterBar
            statuses={statuses}
            taxonomyOptions={taxonomyOptions}
            statusFilter={statusFilter}
            taxonomyFilter={taxonomyFilter}
            textQuery={textQuery}
            feedbackOnly={feedbackOnly}
            changeOnly={changeOnly}
            dirtyOnly={dirtyOnly}
            onStatusFilter={setStatusFilter}
            onTaxonomyFilter={setTaxonomyFilter}
            onTextQuery={setTextQuery}
            onFeedbackOnly={setFeedbackOnly}
            onChangeOnly={setChangeOnly}
            onDirtyOnly={setDirtyOnly}
          />
          {data.inGit ? <DiffLegend /> : null}
          <SpecTree data={data} filter={filter} orphanFilter={orphanFilter} />
        </>
      ) : (
        <Loading />
      )}
    </main>
  );
}
