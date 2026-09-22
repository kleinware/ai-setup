// Shared types for the spec store data, used by both server and client code.

export type SpecEntry = {
  id: string;
  description: string;
  motivation: string;
  acceptance_criteria: string | string[];
  status?: string;
  meta?: unknown;
};

export type FollowUpItem = {
  id: string;
  description?: string;
  motivation?: string;
  acceptance_criteria?: Record<string, string>;
};

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
  config: StoreConfig | null;
  specs: SpecEntry[];
  followUps: FollowUpItem[];
  errors: string[];
};
