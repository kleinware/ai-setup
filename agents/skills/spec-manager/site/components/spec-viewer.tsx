"use client";

// Spec viewer/editor site: renders every spec from the store, grouped by
// taxonomy, with live updates pushed over /api/events.

import { useEffect, useMemo, useState } from "react";
import { RiArrowDownSLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  FollowUpItem,
  SpecEntry,
  StoreData,
} from "@/lib/spec-types";

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

function countSpecs(node: GroupNode): number {
  let count = node.specs.length;
  for (const child of node.children.values()) count += countSpecs(child);
  return count;
}

function criteriaList(criteria: string | string[]): string[] {
  return Array.isArray(criteria) ? criteria : [criteria];
}

function SpecRow({ spec, note }: { spec: SpecEntry; note?: FollowUpItem }) {
  return (
    <Card data-testid={`spec-row-${spec.id}`} className="py-4">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle data-testid={`spec-id-${spec.id}`} className="font-mono text-base">
            {spec.id}
          </CardTitle>
          {spec.status ? (
            <Badge variant="secondary" data-testid={`spec-status-${spec.id}`}>
              {spec.status}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{spec.description}</p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Why:</span> {spec.motivation}
        </p>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Acceptance criteria
          </p>
          <ul className="ml-4 list-disc text-sm">
            {criteriaList(spec.acceptance_criteria).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        {note ? (
          <div data-testid={`follow-up-${spec.id}`} className="rounded-lg bg-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide">
              Follow-up notes
            </p>
            {note.description ? (
              <p className="mt-1 text-sm">{note.description}</p>
            ) : null}
            {note.motivation ? (
              <p className="mt-1 text-sm text-muted-foreground">{note.motivation}</p>
            ) : null}
            {note.acceptance_criteria ? (
              <ol className="ml-4 list-decimal text-sm">
                {Object.entries(note.acceptance_criteria)
                  .sort(
                    (a, b) =>
                      (Number.parseInt(a[0], 10) || 0) -
                      (Number.parseInt(b[0], 10) || 0),
                  )
                  .map(([key, value]) => (
                    <li key={key}>{value}</li>
                  ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LayerGroup({
  node,
  depth,
  layers,
  pathKey,
  followUpsById,
}: {
  node: GroupNode;
  depth: number;
  layers: string[];
  pathKey: string;
  followUpsById: Map<string, FollowUpItem>;
}) {
  const layerName = layers[depth] ?? "";
  const terms = [...node.children.keys()].sort();
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
          {countSpecs(node)}
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
            />
          ))}
          {node.specs.map((spec) => (
            <SpecRow
              key={spec.id}
              spec={spec}
              note={followUpsById.get(spec.id)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SpecTree({ data }: { data: StoreData }) {
  const followUpsById = useMemo(
    () => new Map(data.followUps.map((f) => [f.id, f])),
    [data.followUps],
  );
  const layers = data.config?.taxonomy?.layers;

  if (Array.isArray(layers)) {
    const root = buildTree(data.specs, layers);
    const terms = [...root.children.keys()].sort();
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
          />
        ))}
        {root.specs.map((spec) => (
          <SpecRow key={spec.id} spec={spec} note={followUpsById.get(spec.id)} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.specs.map((spec) => (
        <SpecRow key={spec.id} spec={spec} note={followUpsById.get(spec.id)} />
      ))}
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
          <SpecTree data={data} />
        </>
      ) : (
        <Loading />
      )}
    </main>
  );
}
