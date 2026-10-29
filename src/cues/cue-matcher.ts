import type { Cue, SingleCue } from "../schema/rundown-v2.js";
import { fuzzySubstringMatch } from "./jaro-winkler.js";

export interface EvaluationContext {
  text?: string;
  soundEvent?: "music_start" | "music_stop" | "speech_start" | "speech_stop" | "silence";
  isManual?: boolean;
  variables?: Record<string, string>;
  now?: number;
}

export interface MatchResult {
  matched: boolean;
  score?: number;
  reason?: string;
}

export class CueMatcher {
  private readonly lastFired = new Map<string, number>();

  canFire(cueId: string, cooldownMs = 1500, now = Date.now()): boolean {
    const last = this.lastFired.get(cueId);
    if (!last) return true;
    return now - last >= cooldownMs;
  }

  recordFire(cueId: string, now = Date.now()): void {
    this.lastFired.set(cueId, now);
  }

  evaluate(cue: Cue, context: EvaluationContext, cueId = "default"): MatchResult {
    const now = context.now ?? Date.now();
    const cooldown = cue.cooldown_ms ?? 1500;

    if (!context.isManual && !this.canFire(cueId, cooldown, now)) {
      return { matched: false, reason: "In cooldown period" };
    }

    if (context.isManual) {
      this.recordFire(cueId, now);
      return { matched: true, score: 1.0, reason: "Manual operator trigger" };
    }

    const result = this.evalCueInternal(cue, context);
    if (result.matched) {
      this.recordFire(cueId, now);
    }
    return result;
  }

  private evalCueInternal(cue: Cue, ctx: EvaluationContext): MatchResult {
    if (cue.type === "all") {
      for (const cond of cue.conditions) {
        const res = this.evalSingleCue(cond, ctx);
        if (!res.matched) {
          return { matched: false, reason: `Sub-condition failed: ${res.reason ?? cond.type}` };
        }
      }
      return { matched: true, score: 1.0, reason: "All conditions matched" };
    }

    if (cue.type === "any") {
      for (const cond of cue.conditions) {
        const res = this.evalSingleCue(cond, ctx);
        if (res.matched) {
          return res;
        }
      }
      return { matched: false, reason: "No sub-condition matched" };
    }

    return this.evalSingleCue(cue, ctx);
  }

  private evalSingleCue(cue: SingleCue, ctx: EvaluationContext): MatchResult {
    switch (cue.type) {
      case "manual": {
        return { matched: Boolean(ctx.isManual), reason: "Manual cue" };
      }

      case "phrase": {
        if (!ctx.text) return { matched: false, reason: "No transcript text available" };
        const query = ctx.variables
          ? this.interpolateText(cue.phrase, ctx.variables)
          : cue.phrase;
        const text = cue.caseSensitive ? ctx.text : ctx.text.toLowerCase();
        const target = cue.caseSensitive ? query : query.toLowerCase();
        const matched = text.includes(target);
        return {
          matched,
          score: matched ? 1.0 : 0.0,
          reason: matched ? `Phrase matched '${target}'` : "Phrase not found in text",
        };
      }

      case "fuzzy": {
        if (!ctx.text) return { matched: false, reason: "No transcript text available" };
        const query = ctx.variables
          ? this.interpolateText(cue.phrase, ctx.variables)
          : cue.phrase;
        const threshold = cue.threshold ?? 0.8;
        const res = fuzzySubstringMatch(query, ctx.text, threshold);
        return {
          matched: res.matched,
          score: res.score,
          reason: res.matched
            ? `Fuzzy matched '${query}' with score ${res.score.toFixed(2)} >= ${threshold}`
            : `Fuzzy score ${res.score.toFixed(2)} below threshold ${threshold}`,
        };
      }

      case "regex": {
        if (!ctx.text) return { matched: false, reason: "No transcript text available" };
        try {
          const re = new RegExp(cue.pattern, cue.flags ?? "i");
          const matched = re.test(ctx.text);
          return {
            matched,
            score: matched ? 1.0 : 0.0,
            reason: matched ? `Regex pattern /${cue.pattern}/ matched` : "Regex did not match",
          };
        } catch (err) {
          return { matched: false, reason: `Invalid regex pattern: ${err}` };
        }
      }

      case "sound": {
        if (!ctx.soundEvent) {
          return { matched: false, reason: "No sound event in context" };
        }
        const matched = ctx.soundEvent === cue.event;
        return {
          matched,
          score: matched ? 1.0 : 0.0,
          reason: matched ? `Sound event '${cue.event}' detected` : `Expected '${cue.event}', got '${ctx.soundEvent}'`,
        };
      }
    }
  }

  private interpolateText(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
  }
}
