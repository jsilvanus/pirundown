import { z } from "zod";

// --- Varfetch Connector Schema ---
export const ConnectorAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string() }),
  z.object({ type: z.literal("api_key"), headerName: z.string(), value: z.string() }),
  z.object({ type: z.literal("basic"), username: z.string(), password: z.string().optional() }),
  z.object({ type: z.literal("custom"), headers: z.record(z.string()) }),
]);

export const KeyValueSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const MappingSchema = z.object({
  jsonPath: z.string(),
  variable: z.string(),
  skipIfNull: z.boolean().optional(),
});

export const RequestDefSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
  path: z.string().default(""),
  query: z.array(KeyValueSchema).optional(),
  headers: z.array(KeyValueSchema).optional(),
  bodyType: z.enum(["none", "json", "text"]).optional(),
  body: z.string().optional(),
  responseType: z.enum(["auto", "json", "text", "binary", "image"]).optional(),
  mappings: z.array(MappingSchema).optional(),
  timeoutMs: z.number().positive().optional(),
});

export const ConnectorDefSchema = z.object({
  baseUrl: z.string().url(),
  auth: ConnectorAuthSchema.optional(),
  headers: z.array(KeyValueSchema).optional(),
  requests: z.record(RequestDefSchema).optional(),
});

// --- Cue Schema ---
export const BaseCueSchema = z.object({
  mode: z.enum(["next", "skip", "any"]).default("next"),
  cooldown_ms: z.number().nonnegative().optional(),
});

export const PhraseCueSchema = BaseCueSchema.extend({
  type: z.literal("phrase"),
  phrase: z.string().min(1),
  caseSensitive: z.boolean().default(false),
});

export const FuzzyCueSchema = BaseCueSchema.extend({
  type: z.literal("fuzzy"),
  phrase: z.string().min(1),
  threshold: z.number().min(0).max(1).default(0.8),
});

export const RegexCueSchema = BaseCueSchema.extend({
  type: z.literal("regex"),
  pattern: z.string().min(1),
  flags: z.string().default("i"),
});

export const SoundCueSchema = BaseCueSchema.extend({
  type: z.literal("sound"),
  event: z.enum(["music_start", "music_stop", "speech_start", "speech_stop", "silence"]),
  duration_ms: z.number().nonnegative().optional(),
});

export const ManualCueSchema = BaseCueSchema.extend({
  type: z.literal("manual"),
});

export const SingleCueSchema = z.discriminatedUnion("type", [
  PhraseCueSchema,
  FuzzyCueSchema,
  RegexCueSchema,
  SoundCueSchema,
  ManualCueSchema,
]);

export type SingleCue = z.infer<typeof SingleCueSchema>;

export const CompositeAllCueSchema = BaseCueSchema.extend({
  type: z.literal("all"),
  conditions: z.array(SingleCueSchema).min(1),
});

export const CompositeAnyCueSchema = BaseCueSchema.extend({
  type: z.literal("any"),
  conditions: z.array(SingleCueSchema).min(1),
});

export const CueSchema = z.union([
  SingleCueSchema,
  CompositeAllCueSchema,
  CompositeAnyCueSchema,
]);

export type Cue = z.infer<typeof CueSchema>;

// --- Action Schema ---
export const AtemActionSchema = z.object({
  atem: z.object({
    cut: z.number().optional(),
    auto: z.boolean().optional(),
    dsk: z.number().optional(),
    state: z.enum(["on", "off", "toggle"]).optional(),
    ftb: z.boolean().optional(),
  }),
});

export const CamActionSchema = z.object({
  cam: z.object({
    id: z.union([z.number(), z.string()]),
    preset: z.union([z.string(), z.number()]).optional(),
    move: z.enum(["up", "down", "left", "right", "stop"]).optional(),
    speed: z.number().optional(),
    zoom: z.enum(["in", "out", "stop"]).optional(),
  }),
});

export const TallyActionSchema = z.object({
  tally: z.object({
    unit: z.union([z.number(), z.string()]),
    cue: z.string().optional(),
    state: z.enum(["pgm", "prv", "off"]).optional(),
  }),
});

export const PipgmActionSchema = z.object({
  pipgm: z.object({
    hymn: z.union([z.string(), z.number()]).optional(),
    slide: z.union([z.string(), z.number()]).optional(),
    ftb: z.boolean().optional(),
  }),
});

export const VarActionSchema = z.object({
  var: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

export const FetchActionSchema = z.object({
  fetch: z.object({
    connector: z.string(),
    request: z.string(),
  }),
});

export const DelayActionSchema = z.object({
  delay: z.object({
    ms: z.number().positive(),
  }),
});

export const ActionItemSchema = z.union([
  AtemActionSchema,
  CamActionSchema,
  TallyActionSchema,
  PipgmActionSchema,
  VarActionSchema,
  FetchActionSchema,
  DelayActionSchema,
  z.string(), // Shorthand string syntax, e.g. "cam:1:preset:altar"
]);

export type ActionItem = z.infer<typeof ActionItemSchema>;

// --- Rundown Item Schema ---
export const RundownItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  section: z.string().optional(),
  notes: z.string().optional(),
  cue: CueSchema.optional(),
  actions: z.array(ActionItemSchema).default([]),
});

export type RundownItem = z.infer<typeof RundownItemSchema>;

// --- Top-Level Rundown v2 Document ---
export const PreflightFetchSchema = z.object({
  connector: z.string(),
  request: z.string(),
});

export const PreflightSchema = z.object({
  fetch: z.array(PreflightFetchSchema).optional(),
  variables: z.record(z.unknown()).optional(),
});

export const RundownV2Schema = z.object({
  version: z.literal(2),
  title: z.string().min(1),
  service: z.string().optional(),
  church: z.string().optional(),
  date: z.string().optional(),
  connectors: z.record(ConnectorDefSchema).optional(),
  preflight: PreflightSchema.optional(),
  rundown: z.array(RundownItemSchema).min(1),
});

export type RundownV2 = z.infer<typeof RundownV2Schema>;
