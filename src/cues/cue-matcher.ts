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

export interface CueMatcherOptions {
  piembedUrl?: string;
  fetchFn?: typeof fetch;
  maxContextLines?: number;
}

export class CueMatcher {
  private readonly lastFired = new Map<string, number>();
  private readonly recentLines: string[] = [];
  private readonly piembedUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxContextLines: number;

  constructor(options: CueMatcherOptions = {}) {
    this.piembedUrl = (options.piembedUrl ?? "http://127.0.0.1:3300").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxContextLines = options.maxContextLines ?? 20;
  }

  pushContextLine(text: string): void {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    this.recentLines.push(trimmed);
    if (this.recentLines.length > this.maxContextLines) {
      this.recentLines.splice(0, this.recentLines.length - this.maxContextLines);
    }
  }

  clearContext(): void {
    this.recentLines.length = 0;
  }

  getSemanticCandidates(
    currentText: string,
    mode: "line" | "window" | "both" = "window",
    segments = 3
  ): string[] {
    if (mode === "line") {
      return [currentText];
    }
    const lines = this.recentLines.slice();
    if (lines[lines.length - 1] !== currentText) {
      lines.push(currentText);
    }
    const windowText = lines.slice(-Math.max(1, segments)).join(" ");
    if (mode === "window" || windowText === currentText) {
      return [windowText];
    }
    return [currentText, windowText];
  }

  async preflightCues(
    rundownId: string,
    cues: Array<{ id: string; phrase: string }>
  ): Promise<boolean> {
    if (cues.length === 0) return true;
    try {
      const res = await this.fetchFn(`${this.piembedUrl}/api/v1/cues/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rundownId, cues }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

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
    const defaultCooldown = cue.type === "semantic" ? 5000 : 1500;
    const cooldown = cue.cooldown_ms ?? defaultCooldown;

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

  async evaluateAsync(cue: Cue, context: EvaluationContext, cueId = "default"): Promise<MatchResult> {
    const now = context.now ?? Date.now();
    const defaultCooldown = cue.type === "semantic" ? 5000 : 1500;
    const cooldown = cue.cooldown_ms ?? defaultCooldown;

    if (!context.isManual && !this.canFire(cueId, cooldown, now)) {
      return { matched: false, reason: "In cooldown period" };
    }

    if (context.isManual) {
      this.recordFire(cueId, now);
      return { matched: true, score: 1.0, reason: "Manual operator trigger" };
    }

    const result = await this.evalCueInternalAsync(cue, context, cueId);
    if (result.matched) {
      this.recordFire(cueId, now);
    }
    return result;
  }

  private orderConditionsByCost(conditions: SingleCue[]): Array<{ cond: SingleCue; idx: number }> {
    return conditions
      .map((cond, idx) => ({ cond, idx, cost: cond.type === "semantic" ? 1 : 0 }))
      .sort((a, b) => a.cost - b.cost || a.idx - b.idx);
  }

  private async evalCueInternalAsync(cue: Cue, ctx: EvaluationContext, cueId: string): Promise<MatchResult> {
    if (cue.type === "all") {
      const ordered = this.orderConditionsByCost(cue.conditions);
      for (const { cond, idx } of ordered) {
        const res = await this.evalSingleCueAsync(cond, ctx, `${cueId}:${idx}`);
        if (!res.matched) {
          return { matched: false, reason: `Sub-condition failed: ${res.reason ?? cond.type}` };
        }
      }
      return { matched: true, score: 1.0, reason: "All conditions matched" };
    }

    if (cue.type === "any") {
      const ordered = this.orderConditionsByCost(cue.conditions);
      for (const { cond, idx } of ordered) {
        const res = await this.evalSingleCueAsync(cond, ctx, `${cueId}:${idx}`);
        if (res.matched) {
          return res;
        }
      }
      return { matched: false, reason: "No sub-condition matched" };
    }

    return this.evalSingleCueAsync(cue, ctx, cueId);
  }

  private async evalSingleCueAsync(cue: SingleCue, ctx: EvaluationContext, cueId: string): Promise<MatchResult> {
    if (cue.type !== "semantic") {
      return this.evalSingleCue(cue, ctx);
    }

    if (!ctx.text) {
      return { matched: false, reason: "No transcript text available" };
    }

    const query = ctx.variables
      ? this.interpolateText(cue.phrase, ctx.variables)
      : cue.phrase;
    const threshold = cue.threshold ?? 0.70;
    const candidates = this.getSemanticCandidates(
      ctx.text,
      cue.context_mode ?? "window",
      cue.context_segments ?? 3
    );

    try {
      let bestScore = -1;
      for (const candidate of candidates) {
        const res = await this.fetchFn(`${this.piembedUrl}/api/v1/cues/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: candidate,
            cueIds: [cueId],
            threshold,
          }),
          signal: AbortSignal.timeout(2500),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            matched?: boolean;
            bestMatch?: { score?: number; matched?: boolean } | null;
          };
          if (data.bestMatch && typeof data.bestMatch.score === "number") {
            if (data.bestMatch.score > bestScore) {
              bestScore = data.bestMatch.score;
            }
          }
        }
      }

      if (bestScore >= 0) {
        const matched = bestScore >= threshold;
        return {
          matched,
          score: bestScore,
          reason: matched
            ? `Semantic matched '${query}' with score ${bestScore.toFixed(2)} >= ${threshold}`
            : `Semantic score ${bestScore.toFixed(2)} below threshold ${threshold}`,
        };
      }
    } catch {
      // Fall back to Jaro-Winkler fuzzy matching if piembed is offline
    }

    return this.evalSemanticFallback(query, candidates, threshold);
  }

  private evalSemanticFallback(query: string, candidates: string[], threshold: number): MatchResult {
    let bestScore = 0;
    for (const candidate of candidates) {
      const res = fuzzySubstringMatch(query, candidate, threshold);
      if (res.score > bestScore) {
        bestScore = res.score;
      }
    }
    const matched = bestScore >= threshold;
    return {
      matched,
      score: bestScore,
      reason: matched
        ? `Semantic (fuzzy fallback) matched '${query}' with score ${bestScore.toFixed(2)} >= ${threshold}`
        : `Semantic (fuzzy fallback) score ${bestScore.toFixed(2)} below threshold ${threshold}`,
    };
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

      case "semantic": {
        if (!ctx.text) return { matched: false, reason: "No transcript text available" };
        const query = ctx.variables
          ? this.interpolateText(cue.phrase, ctx.variables)
          : cue.phrase;
        const threshold = cue.threshold ?? 0.70;
        const candidates = this.getSemanticCandidates(
          ctx.text,
          cue.context_mode ?? "window",
          cue.context_segments ?? 3
        );
        return this.evalSemanticFallback(query, candidates, threshold);
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

      case "timer": {
        return {
          matched: false,
          score: 0.0,
          reason: "Timer cues are evaluated by the rundown duration scheduler",
        };
      }
    }
  }

  private interpolateText(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
  }
}
