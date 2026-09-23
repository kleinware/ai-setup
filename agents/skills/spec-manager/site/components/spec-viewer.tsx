"use client";

// Spec viewer/editor site: renders every spec from the store, grouped by
// taxonomy, with live updates pushed over /api/events, status editing via
// the /api/specs/status endpoint, and auto-saved follow-up notes via the
// /api/follow-ups endpoint.

import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
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
import type {
  FollowUpItem,
  SpecEntry,
  StoreData,
} from "@/lib/spec-types";

type StatusOption = { name: string; description: string };

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
// status (when set), taxonomy branch (when set), and text query (when set).
type SpecFilter = (spec: SpecEntry) => boolean;

function makeFilter(
  status: string,
  taxonomy: string,
  query: string,
): SpecFilter {
  const needle = query.trim().toLowerCase();
  return (spec) => {
    if (status !== "" && spec.status !== status) return false;
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
      if (!fields.some((f) => f.toLowerCase().includes(needle))) return false;
    }
    return true;
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
  key: string;
  server: string;
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

function SpecRow({
  spec,
  note,
  statuses,
}: {
  spec: SpecEntry;
  note?: FollowUpItem;
  statuses: StatusOption[];
}) {
  const fieldDefs = useMemo<FieldDef[]>(() => {
    const defs: FieldDef[] = [
      {
        field: "description",
        key: "description",
        server: note?.description ?? "",
      },
      {
        field: "motivation",
        key: "motivation",
        server: note?.motivation ?? "",
      },
    ];
    criteriaList(spec.acceptance_criteria).forEach((_, i) => {
      defs.push({
        field: "criterion",
        index: i,
        key: `criterion-${i}`,
        server: note?.acceptance_criteria?.[String(i)] ?? "",
      });
    });
    return defs;
  }, [spec.acceptance_criteria, note]);

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
      id: spec.id,
      field: def.field,
      value,
    };
    if (def.index !== undefined) payload.index = def.index;
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

  // Status editing: optimistic local update, reverted on a failed save;
  // store updates (SSE refetches) adopt the server status.
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  useEffect(() => {
    setLocalStatus(null);
  }, [spec]);
  const status = localStatus ?? spec.status;

  const handleStatusChange = (next: string) => {
    if (next === status) return;
    setLocalStatus(next);
    fetch("/api/specs/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: spec.id, status: next }),
    })
      .then((res) => {
        if (!res.ok) setLocalStatus(null);
      })
      .catch(() => {
        setLocalStatus(null);
      });
  };

  const criteria = criteriaList(spec.acceptance_criteria);

  return (
    <Item data-testid={`spec-row-${spec.id}`} className="py-4">
      <Collapsible defaultOpen className="w-full">
        <CollapsibleTrigger
          data-testid={`spec-toggle-${spec.id}`}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted dark:hover:bg-muted/50"
        >
          <ItemTitle
            data-testid={`spec-id-${spec.id}`}
            className="font-mono text-base"
          >
            {spec.id}
          </ItemTitle>
          <RiArrowDownSLine className="ml-auto size-4 shrink-0 text-muted-foreground data-[panel-open]:rotate-180 transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            data-testid={`spec-status-area-${spec.id}`}
            className="flex flex-wrap items-center gap-3 px-3 pt-1"
          >
            <span className="shrink-0 text-sm text-muted-foreground">Status</span>
            {statuses.length > 0 ? (
              <RadioGroup
                data-testid={`status-radio-${spec.id}`}
                value={status}
                onValueChange={(v: string) => handleStatusChange(v)}
                className="flex w-fit items-center gap-3"
              >
                {statuses.map((s) => (
                  <label
                    key={s.name}
                    htmlFor={`status-opt-${spec.id}-${s.name}`}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <RadioGroupItem
                      id={`status-opt-${spec.id}-${s.name}`}
                      data-testid={`status-option-${spec.id}-${s.name}`}
                      value={s.name}
                    />
                    {s.name}
                  </label>
                ))}
              </RadioGroup>
            ) : null}
            {status ? (
              <Badge variant="secondary" data-testid={`spec-status-${spec.id}`}>
                {status}
              </Badge>
            ) : null}
          </div>
          <div
            data-testid={`follow-up-${spec.id}`}
            className="space-y-2 px-3 pb-1"
          >
            <p data-testid={`spec-description-${spec.id}`} className="text-sm">
              {spec.description}
            </p>
            <div className="flex items-start gap-2">
              <AutoGrowTextarea
                data-testid={`follow-up-desc-${spec.id}`}
                className="flex-1"
                value={draftOf("description")}
                onChange={(e) => setDraft("description", e.target.value)}
                onBlur={() => triggerSave("description")}
              />
              <NoteIndicator
                testId={`follow-up-indicator-desc-${spec.id}`}
                state={indicator("description")}
              />
            </div>
            <p
              data-testid={`spec-motivation-${spec.id}`}
              className="text-sm text-muted-foreground"
            >
              <span className="font-medium text-foreground">Why:</span>{" "}
              {spec.motivation}
            </p>
            <div className="flex items-start gap-2">
              <AutoGrowTextarea
                data-testid={`follow-up-motivation-${spec.id}`}
                className="flex-1"
                value={draftOf("motivation")}
                onChange={(e) => setDraft("motivation", e.target.value)}
                onBlur={() => triggerSave("motivation")}
              />
              <NoteIndicator
                testId={`follow-up-indicator-motivation-${spec.id}`}
                state={indicator("motivation")}
              />
            </div>
            <div data-testid={`spec-criteria-${spec.id}`}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Acceptance criteria
              </p>
              {criteria.map((c, i) => (
                <div key={i} className="space-y-1">
                  <ul className="ml-4 list-disc text-sm">
                    <li>{c}</li>
                  </ul>
                  <div className="flex items-start gap-2">
                    <AutoGrowTextarea
                      data-testid={`follow-up-criterion-${spec.id}-${i}`}
                      className="flex-1"
                      value={draftOf(`criterion-${i}`)}
                      onChange={(e) => setDraft(`criterion-${i}`, e.target.value)}
                      onBlur={() => triggerSave(`criterion-${i}`)}
                    />
                    <NoteIndicator
                      testId={`follow-up-indicator-criterion-${spec.id}-${i}`}
                      state={indicator(`criterion-${i}`)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

function LayerGroup({
  node,
  depth,
  layers,
  pathKey,
  followUpsById,
  statuses,
  filter,
}: {
  node: GroupNode;
  depth: number;
  layers: string[];
  pathKey: string;
  followUpsById: Map<string, FollowUpItem>;
  statuses: StatusOption[];
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
      <CollapsibleTrigger
        data-testid={`group-${pathKey}-trigger`}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted dark:hover:bg-muted/50"
      >
        <RiArrowDownSLine className="shrink-0 text-muted-foreground data-[panel-open]:rotate-180 transition-transform" />
        <span className="text-sm font-medium">
          <span className="mr-2 text-xs text-muted-foreground">{layerName}</span>
          {node.term}
        </span>
        <Badge variant="outline" className="ml-auto">
          {visibleCount}
        </Badge>
      </CollapsibleTrigger>
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
              filter={filter}
            />
          ))}
          {visibleSpecs.map((spec) => (
            <SpecRow
              key={spec.id}
              spec={spec}
              note={followUpsById.get(spec.id)}
              statuses={statuses}
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
}: {
  data: StoreData;
  filter: SpecFilter;
}) {
  const followUpsById = useMemo(
    () => new Map(data.followUps.map((f) => [f.id, f])),
    [data.followUps],
  );
  const layers = data.config?.taxonomy?.layers;
  const statuses = Array.isArray(data.config?.status)
    ? data.config.status
    : [];

  if (Array.isArray(layers)) {
    const root = buildTree(data.specs, layers);
    const terms = [...root.children.keys()]
      .filter((term) => countVisible(root.children.get(term)!, filter) > 0)
      .sort();
    const visibleRootSpecs = root.specs.filter(filter);
    const visibleTotal =
      terms.reduce((sum, term) => sum + countVisible(root.children.get(term)!, filter), 0) +
      visibleRootSpecs.length;
    if (visibleTotal === 0) {
      return (
        <div data-testid="no-matches" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No specs match the active filters.
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {terms.map((term) => (
          <LayerGroup
            key={term}
            node={root.children.get(term)!}
            depth={0}
            layers={layers}
            pathKey={term}
            followUpsById={followUpsById}
            statuses={statuses}
            filter={filter}
          />
        ))}
        {visibleRootSpecs.map((spec) => (
          <SpecRow
            key={spec.id}
            spec={spec}
            note={followUpsById.get(spec.id)}
            statuses={statuses}
          />
        ))}
      </div>
    );
  }

  const visibleSpecs = data.specs.filter(filter);
  if (visibleSpecs.length === 0) {
    return (
      <div data-testid="no-matches" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No specs match the active filters.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {visibleSpecs.map((spec) => (
        <SpecRow
          key={spec.id}
          spec={spec}
          note={followUpsById.get(spec.id)}
          statuses={statuses}
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
  onStatusFilter,
  onTaxonomyFilter,
  onTextQuery,
}: {
  statuses: StatusOption[];
  taxonomyOptions: string[];
  statusFilter: string;
  taxonomyFilter: string;
  textQuery: string;
  onStatusFilter: (value: string) => void;
  onTaxonomyFilter: (value: string) => void;
  onTextQuery: (value: string) => void;
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
  // Active filters; "" means no filter for that control. All three apply
  // together (AND); clearing one restores the list subject to the rest.
  const [statusFilter, setStatusFilter] = useState("");
  const [taxonomyFilter, setTaxonomyFilter] = useState("");
  const [textQuery, setTextQuery] = useState("");

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

  const config = data?.config;
  const statuses = config && Array.isArray(config.status) ? config.status : [];
  const taxonomyOptions = useMemo(
    () => (data ? collectTaxonomyOptions(data) : []),
    [data],
  );
  const filter = useMemo(
    () => makeFilter(statusFilter, taxonomyFilter, textQuery),
    [statusFilter, taxonomyFilter, textQuery],
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
            onStatusFilter={setStatusFilter}
            onTaxonomyFilter={setTaxonomyFilter}
            onTextQuery={setTextQuery}
          />
          <SpecTree data={data} filter={filter} />
        </>
      ) : (
        <Loading />
      )}
    </main>
  );
}
