import { GlobalCueSchema, type ActionItem, type GlobalCue } from "../schema/rundown-v2.js";

/**
 * Matches section/topic names across English and Finnish liturgical terms.
 */
export function matchesLiturgicalSection(actual: string | null | undefined, target: string): boolean {
  if (!actual) return false;
  const a = actual.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (!a || !t) return false;
  if (a.includes(t) || t.includes(a)) return true;
  if (t === "communion" && a.includes("ehtoollinen")) return true;
  if (t === "ehtoollinen" && a.includes("communion")) return true;
  if (t === "sermon" && a.includes("saarna")) return true;
  if (t === "saarna" && a.includes("sermon")) return true;
  if (t === "prayer" && (a.includes("rukous") || a.includes("esirukous"))) return true;
  if (t === "rukous" && a.includes("prayer")) return true;
  if (t === "intro" && (a.includes("johdanto") || a.includes("alku"))) return true;
  return false;
}

/**
 * Compiles a natural-language global cue prompt into a structured GlobalCue.
 * Example: "when communion starts, do privacy blur on camera 1"
 */
export function compileGlobalCueFromPrompt(promptText: string, id?: string): GlobalCue {
  const lower = promptText.toLowerCase().trim();

  // 1. Determine trigger
  let event: GlobalCue["trigger"]["event"] = "section_start";
  let section: string | undefined;
  let phrase: string | undefined;

  if (lower.includes("communion") || lower.includes("ehtoollinen")) {
    section = "communion";
  } else if (lower.includes("sermon") || lower.includes("saarna")) {
    section = "sermon";
  } else if (lower.includes("prayer") || lower.includes("rukous")) {
    section = "prayer";
  } else if (lower.includes("intro") || lower.includes("johdanto") || lower.includes("opening")) {
    section = "intro";
  }

  if (/\b(?:ends?|finishes|after|passed)\b/i.test(lower) && section) {
    event = "section_end";
  } else if (/\b(?:speaks?\s+about|says?|mentions?|phrase)\s+["']?([a-zäöå0-9\s-]+)["']?/i.test(promptText)) {
    const m = /\b(?:speaks?\s+about|says?|mentions?|phrase)\s+["']?([a-zäöå0-9\s-]+?)["']?(?:\s*,|\s+do|\s+put|\s+cut|$)/i.exec(
      promptText
    );
    if (m?.[1]) {
      event = "phrase";
      phrase = m[1].trim();
    }
  } else if (!section) {
    const whenMatch = /\bwhen\s+([a-zäöå0-9_-]+)\s+(?:starts?|begins?)\b/i.exec(promptText);
    if (whenMatch?.[1]) {
      section = whenMatch[1].toLowerCase();
    } else {
      section = "communion";
    }
  }

  // 2. Determine actions
  const actions: ActionItem[] = [];
  const camMatch = /\bcam(?:era)?\s*(\d+)\b/i.exec(promptText);
  const camId = camMatch ? Number.parseInt(camMatch[1]!, 10) : 1;

  if (lower.includes("privacy blur") || lower.includes("blur")) {
    const disable = /\b(off|disable|remove|clear)\b/i.test(lower);
    actions.push({
      cam: {
        id: camId,
        privacyBlur: !disable,
      },
    });
  }

  const presetMatch = /\bpreset\s*(\d+|[a-z0-9_-]+)\b/i.exec(promptText);
  if (presetMatch) {
    const rawPreset = presetMatch[1]!;
    const preset = /^\d+$/.test(rawPreset) ? Number.parseInt(rawPreset, 10) : rawPreset;
    const cutAfterMoved =
      /\bcut\s+after\s+moved\b/i.test(lower) || /\bcut\s+when\s+settled\b/i.test(lower);
    actions.push({
      cam: {
        id: camId,
        preset,
        ...(cutAfterMoved ? { cutAfterMoved: true } : {}),
      },
    });
  }

  if (lower.includes("dsk") || lower.includes("graphic")) {
    const gMatch = /\bputs?\s+([a-z0-9_-]+)\s+graphic\b/i.exec(promptText);
    const graphic = gMatch?.[1] ?? "overlay";
    const off = /\b(off|hide|clear)\b/i.test(lower);
    actions.push({
      atem: {
        dsk: 1,
        state: off ? "off" : "on",
        graphic,
      },
    });
  }

  const cutMatch = /\bcut\s+to\s+(?:cam(?:era)?|input)?\s*(\d+)\b/i.exec(promptText);
  if (cutMatch) {
    actions.push({
      atem: {
        cut: Number.parseInt(cutMatch[1]!, 10),
      },
    });
  }

  if (actions.length === 0) {
    actions.push({
      cam: {
        id: camId,
        privacyBlur: true,
      },
    });
  }

  const cueId = id ?? `gcue_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return GlobalCueSchema.parse({
    id: cueId,
    name: promptText.trim(),
    prompt: promptText.trim(),
    enabled: true,
    oncePerSection: true,
    trigger: {
      event,
      ...(section ? { section } : {}),
      ...(phrase ? { phrase } : {}),
    },
    actions,
    createdAt: new Date().toISOString(),
  });
}
