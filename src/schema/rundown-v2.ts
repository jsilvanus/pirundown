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

export const SemanticCueSchema = BaseCueSchema.extend({
  type: z.literal("semantic"),
  phrase: z.string().min(1),
  threshold: z.number().min(0).max(1).default(0.70),
  context_mode: z.enum(["line", "window", "both"]).default("window"),
  context_segments: z.number().int().min(1).max(20).default(3),
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

export const DurationValueSchema = z.union([z.number().nonnegative(), z.string().min(1)]);
export type DurationValue = z.infer<typeof DurationValueSchema>;

export const TimerCueSchema = BaseCueSchema.extend({
  type: z.literal("timer"),
  timer: DurationValueSchema.optional(),
  duration: DurationValueSchema.optional(),
  duration_sec: z.number().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
});

export const SingleCueSchema = z.discriminatedUnion("type", [
  PhraseCueSchema,
  FuzzyCueSchema,
  SemanticCueSchema,
  RegexCueSchema,
  SoundCueSchema,
  ManualCueSchema,
  TimerCueSchema,
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
export const SwitchVideoActionSchema = z.object({
  cut: z.union([z.number(), z.string()]).optional(),
  preview: z.union([z.number(), z.string()]).optional(),
  program: z.union([z.number(), z.string()]).optional(),
  auto: z.boolean().optional(),
  dsk: z.number().optional(),
  graphic: z.string().optional(),
  state: z.enum(["on", "off", "toggle"]).optional(),
  ftb: z.boolean().optional(),
});

export const SwitchActionSchema = z.object({
  switch: SwitchVideoActionSchema,
});

export const AtemActionSchema = z.object({
  atem: SwitchVideoActionSchema,
});

export const CamActionSchema = z.object({
  cam: z.object({
    id: z.union([z.number(), z.string()]),
    preset: z.union([z.string(), z.number()]).optional(),
    cutAfterMoved: z.boolean().optional(),
    privacyBlur: z.boolean().optional(),
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

export const IntervalValueSchema = z.union([
  z.number().positive(),
  z.tuple([z.number().positive(), z.number().positive()]),
  z.array(z.number().positive()).min(2).max(2),
]);

export const AlternateActionSchema = z.object({
  alternate: z.object({
    interval_sec: IntervalValueSchema.optional(),
    interval_ms: IntervalValueSchema.optional(),
    interval: IntervalValueSchema.optional(),
    during: z.enum(["any", "speech", "music", "silence"]).default("any"),
    cut: z.array(z.number()).optional(),
    steps: z.array(z.any()).optional(),
  }),
});

export const ActionItemSchema = z.union([
  SwitchActionSchema,
  AtemActionSchema,
  CamActionSchema,
  TallyActionSchema,
  PipgmActionSchema,
  VarActionSchema,
  FetchActionSchema,
  DelayActionSchema,
  AlternateActionSchema,
  z.string(), // Shorthand string syntax, e.g. "cam:1:preset:altar"
]);

export type ActionItem = z.infer<typeof ActionItemSchema>;

// --- AI Instruction Schemas ---
export const AiPacingSchema = z.enum(["meditative", "calm", "liturgical", "dynamic", "brisk"]);
export const AiFramingSchema = z.enum(["wide", "medium", "close", "extreme-close", "over-shoulder", "ambient"]);

export const AiShotRuleSchema = z.object({
  condition: z.string(),
  target: z.string(),
  priority: z.number().min(1).max(10).optional(),
});

export const AiConstraintsSchema = z.object({
  disallowCongregationCloseup: z.boolean().optional(),
  minShotDwellSec: z.number().positive().optional(),
  maxShotDwellSec: z.number().positive().optional(),
  avoidCutsDuringPrayer: z.boolean().optional(),
  disallowMoveWhileOnAir: z.boolean().optional(),
}).passthrough();

export const AiGeneralObjectSchema = z.object({
  general: z.string().optional(),
  pacing: z.union([AiPacingSchema, z.string()]).optional(),
  style: z.string().optional(),
  guidelines: z.array(z.string()).optional(),
  constraints: AiConstraintsSchema.optional(),
  cameraRoles: z.record(z.string()).optional(),
  sections: z.record(z.union([z.string(), z.record(z.unknown())])).optional(),
}).passthrough();

export const AiGeneralInstructionsSchema = z.union([
  z.string(),
  AiGeneralObjectSchema,
]);

export type AiGeneralInstructions = z.infer<typeof AiGeneralInstructionsSchema>;

export const AiItemObjectSchema = z.object({
  instructions: z.string().optional(),
  targetZone: z.string().optional(),
  primarySubject: z.string().optional(),
  preferredCameras: z.array(z.union([z.number(), z.string()])).optional(),
  framing: z.union([AiFramingSchema, z.string()]).optional(),
  pacing: z.union([AiPacingSchema, z.string()]).optional(),
  minDurationSec: z.number().nonnegative().optional(),
  shotRules: z.array(AiShotRuleSchema).optional(),
  graphicsCue: z.record(z.unknown()).optional(),
}).passthrough();

export const AiItemInstructionsSchema = z.union([
  z.string(),
  AiItemObjectSchema,
]);

export type AiItemInstructions = z.infer<typeof AiItemInstructionsSchema>;

// --- Rundown Item Schema ---
export const RundownSubitemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  duration: DurationValueSchema.optional(),
  expected_duration: DurationValueSchema.optional(),
  duration_sec: z.number().nonnegative().optional(),
  timer: DurationValueSchema.optional(),
  ai: AiItemInstructionsSchema.optional(),
  cue: CueSchema.optional(),
  actions: z.array(ActionItemSchema).default([]),
});

export type RundownSubitem = z.infer<typeof RundownSubitemSchema>;

export const RundownItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    section: z.string().optional(),
    notes: z.string().optional(),
    duration: DurationValueSchema.optional(),
    expected_duration: DurationValueSchema.optional(),
    duration_sec: z.number().nonnegative().optional(),
    timer: DurationValueSchema.optional(),
    ai: AiItemInstructionsSchema.optional(),
    cue: CueSchema.optional(),
    actions: z.array(ActionItemSchema).default([]),
    subitems: z.array(RundownSubitemSchema).optional(),
    items: z.array(RundownItemSchema).optional(),
  })
);

export type RundownItem = {
  id?: string;
  title?: string;
  section?: string;
  notes?: string;
  duration?: DurationValue;
  expected_duration?: DurationValue;
  duration_sec?: number;
  timer?: DurationValue;
  ai?: AiItemInstructions;
  cue?: Cue;
  actions: ActionItem[];
  subitems?: RundownSubitem[];
  items?: RundownItem[];
};

// --- Global Cue Schema (broadcast-wide reactive cues living alongside item cues) ---
export const GlobalCueTriggerSchema = z.object({
  event: z
    .enum(["section_start", "section_end", "item_start", "phrase", "sound"])
    .default("section_start"),
  section: z.string().optional(),
  itemId: z.string().optional(),
  phrase: z.string().optional(),
  soundEvent: z
    .enum(["music_start", "music_stop", "speech_start", "speech_stop", "silence"])
    .optional(),
});
export type GlobalCueTrigger = z.infer<typeof GlobalCueTriggerSchema>;

export const GlobalCueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().optional(),
  enabled: z.boolean().default(true),
  oncePerSection: z.boolean().default(true),
  trigger: GlobalCueTriggerSchema,
  actions: z.array(ActionItemSchema).min(1),
  createdAt: z.string().optional(),
});
export type GlobalCue = z.infer<typeof GlobalCueSchema>;

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
  duration: DurationValueSchema.optional(),
  expected_duration: DurationValueSchema.optional(),
  duration_sec: z.number().nonnegative().optional(),
  ai: AiGeneralInstructionsSchema.optional(),
  connectors: z.record(ConnectorDefSchema).optional(),
  preflight: PreflightSchema.optional(),
  global_cues: z.array(GlobalCueSchema).optional(),
  rundown: z.array(RundownItemSchema).min(1),
});

export type RundownV2 = z.infer<typeof RundownV2Schema>;

/**
 * Parses duration values like "1:15:00", "15:00", "3:03", "15m", "90s", or numeric seconds into seconds.
 */
export function parseDurationSec(
  val?: string | number | null,
  fallbackSec?: number | null
): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) {
    return Math.max(0, Math.round(val));
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map((p) => Number.parseInt(p.trim(), 10));
      if (parts.every((n) => !Number.isNaN(n))) {
        if (parts.length === 3) {
          return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
        }
        if (parts.length === 2) {
          return parts[0]! * 60 + parts[1]!;
        }
      }
    }
    const unitMatch = /^(\d+(?:\.\d+)?)\s*(h|m|min|s|sec)?$/i.exec(trimmed);
    if (unitMatch) {
      const num = Number.parseFloat(unitMatch[1]!);
      const unit = (unitMatch[2] ?? "s").toLowerCase();
      if (unit === "h") return Math.round(num * 3600);
      if (unit === "m" || unit === "min") return Math.round(num * 60);
      return Math.round(num);
    }
  }
  if (typeof fallbackSec === "number" && !Number.isNaN(fallbackSec)) {
    return Math.max(0, Math.round(fallbackSec));
  }
  return null;
}

/**
 * Formats seconds into M:SS (e.g. "5:00", "26:03") or H:MM:SS (e.g. "1:15:00").
 */
export function formatDurationSec(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const secStr = String(secs).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${secStr}`;
  }
  return `${mins}:${secStr}`;
}

export function formatTimingPair(elapsedSec: number, expectedSec?: number | null): string {
  const el = formatDurationSec(elapsedSec);
  if (expectedSec !== undefined && expectedSec !== null && expectedSec > 0) {
    return `${el}/${formatDurationSec(expectedSec)}`;
  }
  return el;
}

/**
 * Resolves an item's auto-advance timer in seconds from either `item.timer` (number or "M:SS"/"H:MM:SS")
 * or `item.cue` (`{ type: "timer", ... }`).
 */
export function parseTimerSec(
  timerVal?: string | number | null,
  cue?: unknown,
  fallbackDurationSec?: number | null
): number | null {
  const direct = parseDurationSec(timerVal);
  if (direct !== null && direct > 0) {
    return direct;
  }
  const cueObj = cue as Record<string, any> | undefined;
  if (cueObj && cueObj.type === "timer") {
    if (typeof cueObj.duration_ms === "number" && cueObj.duration_ms > 0) {
      return Math.max(1, Math.round(cueObj.duration_ms / 1000));
    }
    const cueSec =
      parseDurationSec(cueObj.timer ?? cueObj.duration, cueObj.duration_sec) ??
      fallbackDurationSec ??
      null;
    if (cueSec !== null && cueSec > 0) {
      return cueSec;
    }
  }
  return null;
}
