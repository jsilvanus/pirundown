export type ItemStatus = "pending" | "active" | "completed" | "skipped";
export type DisplayLineType = "section" | "item" | "subitem";

export interface DisplayLine {
  line: number;              // 1-based display line number (1, 2, 3...)
  type: DisplayLineType;
  level: number;             // 0 for section, 1 for item, 2 for subitem
  id: string;                // Unique ID
  parentId?: string | undefined;
  title: string;
  section?: string | undefined;
  notes?: string | undefined;
  status: ItemStatus;
  hasCue: boolean;
  cueSummary?: string | undefined;
  actionCount: number;
  actionsSummary: string[];
  targetId: string;          // The executable item ID triggered when this line is fired
  targetLine: number;        // The display line number of the executable item
  isExecutable: boolean;     // True for items and subitems with actions/cues
}

export interface RundownDisplay {
  lines: DisplayLine[];
  totalLines: number;
  currentLine: number | null;
  activeSection?: string | null;
}

export interface ExecutableItem {
  id: string;
  line: number;
  title: string;
  section?: string | undefined;
  notes?: string | undefined;
  cue?: unknown | undefined;
  actions: unknown[];
  parentId?: string | undefined;
}

export function summarizeAction(action: unknown): string {
  if (typeof action === "string") {
    const parts = action.split(":");
    if (parts[0] === "cam") {
      const preset = parts[3] ? ` (${parts[3]})` : parts[2] ? ` (${parts[2]})` : "";
      return `CAM ${parts[1]}${preset}`;
    }
    if (parts[0] === "atem" && parts[1] === "cut") return `ATEM Cut ${parts[2] ?? ""}`.trim();
    if (parts[0] === "pipgm" || parts[0] === "pgm") return `Hymn ${parts[2] ?? ""}`.trim();
    if (parts[0] === "tally") return `Tally ${parts[2]} (${parts[3] ?? ""})`;
    return action;
  }
  if (typeof action === "object" && action !== null) {
    if ("cam" in action) {
      const cam = (action as any).cam;
      if (cam.preset !== undefined) return `CAM ${cam.id} (${cam.preset})`;
      if (cam.move) return `CAM ${cam.id} move ${cam.move}`;
      if (cam.zoom) return `CAM ${cam.id} zoom ${cam.zoom}`;
    }
    if ("atem" in action) {
      const atem = (action as any).atem;
      if (atem.cut !== undefined) return `ATEM Cut ${atem.cut}`;
      if (atem.auto) return `ATEM Auto`;
      if (atem.ftb) return `ATEM FTB`;
      if (atem.dsk !== undefined) return `ATEM DSK ${atem.dsk} ${atem.state ?? ""}`.trim();
    }
    if ("pipgm" in action) {
      const pgm = (action as any).pipgm;
      if (pgm.hymn !== undefined) return `Hymn ${pgm.hymn}`;
      if (pgm.slide !== undefined) return `Slide ${pgm.slide}`;
    }
    if ("tally" in action) {
      const tally = (action as any).tally;
      if (tally.cue) return `Tally ${tally.unit} (${tally.cue})`;
      if (tally.state) return `Tally ${tally.unit} ${tally.state}`;
    }
    if ("var" in action) {
      const entries = Object.entries((action as any).var).map(([k, v]) => `${k}=${v}`).join(", ");
      return `Set ${entries}`;
    }
  }
  return "Action";
}

export function summarizeCue(cue: unknown): string | undefined {
  if (!cue || typeof cue !== "object") return undefined;
  const c = cue as any;
  if (c.type === "sound") return `Sound: ${c.event ?? "event"}`;
  if (c.type === "fuzzy") return `Speech: "${c.phrase ?? ""}"`;
  if (c.type === "phrase") return `Exact: "${c.phrase ?? ""}"`;
  if (c.type === "regex") return `Regex: /${c.pattern ?? ""}/`;
  if (c.type === "manual") return `Manual`;
  return String(c.type ?? "Cue");
}

/**
 * Builds the presentational display lines and flat executable items from a rundown doc.
 */
export function buildRundownDisplay(
  rawRundown: unknown[],
  itemStates: Map<string, ItemStatus>,
  currentExecutableId?: string | null
): { display: RundownDisplay; executableItems: ExecutableItem[] } {
  const lines: DisplayLine[] = [];
  const executableItems: ExecutableItem[] = [];

  let currentSection = "";
  let lineCounter = 1;

  for (const entry of rawRundown) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as any;

    // Check if this is an explicit section header
    const isExplicitSection =
      ("section" in item && !("cue" in item) && !("actions" in item) && (!item.id || item.id.startsWith("sec_") || item.id === item.section)) ||
      (item.type === "section");

    if (isExplicitSection) {
      const secName = String(item.section ?? item.title ?? "Section");
      currentSection = secName;
      const secId = item.id ? String(item.id) : `sec_${secName.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;

      lines.push({
        line: lineCounter++,
        type: "section",
        level: 0,
        id: secId,
        title: String(item.title ?? secName),
        section: secName,
        notes: item.notes,
        status: "pending", // computed after children processed
        hasCue: false,
        actionCount: 0,
        actionsSummary: [],
        targetId: "", // resolved after items are added
        targetLine: 0,
        isExecutable: false,
      });

      // If the section object has nested items array
      if (Array.isArray(item.items)) {
        for (const childItem of item.items) {
          processItem(childItem, secName, secId);
        }
      }
      continue;
    }

    // Standard item: check if section changed implicitly
    const itemSec = item.section ? String(item.section) : undefined;
    if (itemSec && itemSec !== currentSection) {
      currentSection = itemSec;
      const secId = `sec_${itemSec.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
      lines.push({
        line: lineCounter++,
        type: "section",
        level: 0,
        id: secId,
        title: itemSec,
        section: itemSec,
        status: "pending",
        hasCue: false,
        actionCount: 0,
        actionsSummary: [],
        targetId: "",
        targetLine: 0,
        isExecutable: false,
      });
    }

    processItem(item, currentSection);
  }

  function processItem(item: any, sectionName?: string, parentSectionId?: string): void {
    const itemId = String(item.id ?? `item_${lineCounter}`);
    const itemActions: unknown[] = Array.isArray(item.actions) ? item.actions : [];
    const hasSubitems = Array.isArray(item.subitems) && item.subitems.length > 0;
    const isExecutable = !hasSubitems || itemActions.length > 0;

    const itemLineNum = lineCounter++;
    const itemLine: DisplayLine = {
      line: itemLineNum,
      type: "item",
      level: 1,
      id: itemId,
      parentId: parentSectionId,
      title: String(item.title ?? itemId),
      section: sectionName,
      notes: item.notes,
      status: itemStates.get(itemId) ?? "pending",
      hasCue: Boolean(item.cue),
      cueSummary: summarizeCue(item.cue),
      actionCount: itemActions.length,
      actionsSummary: itemActions.map(summarizeAction),
      targetId: itemId,
      targetLine: itemLineNum,
      isExecutable,
    };
    lines.push(itemLine);

    if (isExecutable) {
      executableItems.push({
        id: itemId,
        line: itemLineNum,
        title: itemLine.title,
        section: sectionName,
        notes: item.notes,
        cue: item.cue,
        actions: itemActions,
        parentId: parentSectionId,
      });
    }

    // Process subitems if present
    if (hasSubitems) {
      let firstSubitemLine: number | null = null;
      let firstSubitemId: string | null = null;

      for (const sub of item.subitems) {
        const subId = String(sub.id ?? `${itemId}_sub_${lineCounter}`);
        const subActions: unknown[] = Array.isArray(sub.actions) ? sub.actions : [];
        const subLineNum = lineCounter++;

        if (firstSubitemLine === null) {
          firstSubitemLine = subLineNum;
          firstSubitemId = subId;
        }

        const subLine: DisplayLine = {
          line: subLineNum,
          type: "subitem",
          level: 2,
          id: subId,
          parentId: itemId,
          title: String(sub.title ?? subId),
          section: sectionName,
          notes: sub.notes,
          status: itemStates.get(subId) ?? "pending",
          hasCue: Boolean(sub.cue),
          cueSummary: summarizeCue(sub.cue),
          actionCount: subActions.length,
          actionsSummary: subActions.map(summarizeAction),
          targetId: subId,
          targetLine: subLineNum,
          isExecutable: true,
        };
        lines.push(subLine);

        executableItems.push({
          id: subId,
          line: subLineNum,
          title: subLine.title,
          section: sectionName,
          notes: sub.notes,
          cue: sub.cue,
          actions: subActions,
          parentId: itemId,
        });
      }

      // If parent item had no actions of its own, its target is its first subitem
      if (!isExecutable && firstSubitemLine !== null && firstSubitemId !== null) {
        itemLine.targetLine = firstSubitemLine;
        itemLine.targetId = firstSubitemId;
      }
    }
  }

  // Second pass: resolve section header targetLine & targetId (first executable child)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.type === "section") {
      // Find next executable line belonging to this section or until next section
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j]!;
        if (candidate.type === "section") break;
        if (candidate.isExecutable) {
          line.targetId = candidate.targetId;
          line.targetLine = candidate.targetLine;
          break;
        }
      }
      if (!line.targetId && i + 1 < lines.length) {
        line.targetId = lines[i + 1]!.targetId;
        line.targetLine = lines[i + 1]!.targetLine;
      }
    }
  }

  // Third pass: compute aggregate statuses for section headers and parent items
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.type === "section") {
      const childLines: DisplayLine[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.type === "section") break;
        childLines.push(lines[j]!);
      }
      if (childLines.length > 0) {
        if (childLines.some((c) => c.status === "active")) {
          line.status = "active";
        } else if (childLines.every((c) => c.status === "completed" || c.status === "skipped")) {
          line.status = "completed";
        } else if (childLines.some((c) => c.status === "completed")) {
          line.status = "active";
        } else {
          line.status = "pending";
        }
      }
    } else if (line.type === "item" && !line.isExecutable) {
      // Parent container item with subitems
      const subLines = lines.filter((l) => l.parentId === line.id && l.type === "subitem");
      if (subLines.length > 0) {
        if (subLines.some((s) => s.status === "active")) {
          line.status = "active";
        } else if (subLines.every((s) => s.status === "completed" || s.status === "skipped")) {
          line.status = "completed";
        } else {
          line.status = "pending";
        }
      }
    }
  }

  // Find active line and active section
  let currentLine: number | null = null;
  let activeSection: string | null = null;

  if (currentExecutableId) {
    const activeLine = lines.find((l) => l.id === currentExecutableId && l.isExecutable);
    if (activeLine) {
      currentLine = activeLine.line;
      activeSection = activeLine.section ?? null;
    }
  }

  if (currentLine === null) {
    const activeLine = lines.find((l) => l.status === "active" && l.isExecutable);
    if (activeLine) {
      currentLine = activeLine.line;
      activeSection = activeLine.section ?? null;
    }
  }

  return {
    display: {
      lines,
      totalLines: lines.length,
      currentLine,
      activeSection,
    },
    executableItems,
  };
}
