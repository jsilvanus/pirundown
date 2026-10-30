import { readFileSync, existsSync } from "node:fs";

function printHelp(): void {
  console.log(`
pirundown - CLI for the Pi Rundown & Cue Engine

Usage:
  pirundown status                     Get current rundown state and active item
  pirundown display                    Render the full presentational rundown display
  pirundown load <file.yaml>           Load and activate a Rundown v2 YAML file
  pirundown next                       Advance to the next item
  pirundown prev                       Step back to the previous item
  pirundown goto <id>                  Jump directly to item ID
  pirundown skip [id]                  Skip current (or specified) item
  pirundown fire [target]              Manually fire line number or item ID (e.g. 17 or saarna)
  pirundown reset                      Reset active rundown to start
  pirundown cues [on|off|toggle]       Toggle or set cue engine (pure human control mode)
  pirundown vars                       List all active variables
  pirundown set <name> <value>         Set a variable value
  pirundown transcript <text>          Inject transcript text for testing
  pirundown sound <event>              Inject sound event (music_start, etc.)

Global Options:
  --url <url>      pirundown service URL (default: http://127.0.0.1:3400 or PIRUNDOWN_URL)
  --key <key>      API authorization key (PIRUNDOWN_API_KEY)
  --json           Output raw JSON
`);
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  let baseUrl = process.env.PIRUNDOWN_URL ?? "http://127.0.0.1:3400";
  let apiKey = process.env.PIRUNDOWN_API_KEY;
  let jsonMode = false;

  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--url" && i + 1 < args.length) {
      baseUrl = args[++i]!;
    } else if (arg === "--key" && i + 1 < args.length) {
      apiKey = args[++i]!;
    } else if (arg === "--json") {
      jsonMode = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  baseUrl = baseUrl.replace(/\/+$/, "");

  const command = filteredArgs[0]?.toLowerCase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.json();
  };

  try {
    switch (command) {
      case "display":
      case "status": {
        const data = await get("/api/v1/status");
        if (jsonMode) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const rd = (data as any).rundown;
          if (!rd?.loaded) {
            console.log("No rundown loaded.");
          } else {
            console.log(`\nRundown: ${rd.title} (${rd.service ?? "Service"})`);
            console.log(`Active Line: [Line ${rd.currentLine ?? "-"}] | Total Display Lines: ${rd.totalLines ?? rd.display?.totalLines ?? rd.totalItems}`);
            console.log(`Current:     ${rd.currentItem?.title ?? "None"} (${rd.currentItem?.id ?? "-"})`);
            console.log(`Status:      ${rd.currentItem?.status ?? "-"}`);
            const cueState = rd.cueEngineEnabled !== false ? "ENABLED (Auto cues active)" : "OFF (Pure human control mode)";
            console.log(`Cues:        ${cueState}\n`);
            console.log("Presentational Rundown Display:");
            console.log("-------------------------------------------------------------------------------");
            const rows = rd.display?.lines ?? rd.items ?? [];
            for (const row of rows) {
              const marker = row.line === rd.currentLine ? "👉" : "  ";
              const lineStr = String(row.line ?? "").padStart(2);
              const statusTag = `[${row.status.toUpperCase()}]`.padEnd(11);
              if (row.type === "section") {
                console.log(`${marker} Line ${lineStr} ${statusTag} === ${row.title.toUpperCase()} ===`);
              } else if (row.type === "subitem") {
                const cue = row.cueSummary ? ` [${row.cueSummary}]` : "";
                const acts = row.actionsSummary?.length ? ` -> ${row.actionsSummary.join(", ")}` : "";
                console.log(`${marker} Line ${lineStr} ${statusTag}   ↳ ${row.title}${cue}${acts}`);
              } else {
                const cue = row.cueSummary ? ` [${row.cueSummary}]` : "";
                const acts = row.actionsSummary?.length ? ` -> ${row.actionsSummary.join(", ")}` : "";
                console.log(`${marker} Line ${lineStr} ${statusTag} ${row.title}${cue}${acts}`);
              }
            }
            console.log("-------------------------------------------------------------------------------");
          }
        }
        break;
      }

      case "load": {
        const pathOrYaml = filteredArgs[1];
        if (!pathOrYaml) {
          console.error("Error: Please provide a YAML file path or YAML content.");
          process.exit(1);
        }
        let payload: { yaml?: string; path?: string };
        if (existsSync(pathOrYaml)) {
          payload = { yaml: readFileSync(pathOrYaml, "utf-8") };
        } else {
          payload = { yaml: pathOrYaml };
        }
        const res = await post("/api/v1/rundown/load", payload);
        console.log(jsonMode ? JSON.stringify(res, null, 2) : "Rundown loaded successfully.");
        break;
      }

      case "next": {
        const res = await post("/api/v1/rundown/next");
        console.log(jsonMode ? JSON.stringify(res, null, 2) : "Advanced to next item.");
        break;
      }

      case "prev": {
        const res = await post("/api/v1/rundown/previous");
        console.log(jsonMode ? JSON.stringify(res, null, 2) : "Stepped back to previous item.");
        break;
      }

      case "goto": {
        const id = filteredArgs[1];
        if (!id) {
          console.error("Error: Missing item ID.");
          process.exit(1);
        }
        const res = await post(`/api/v1/rundown/goto/${encodeURIComponent(id)}`);
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Jumped to item '${id}'.`);
        break;
      }

      case "skip": {
        const id = filteredArgs[1];
        const res = await post("/api/v1/rundown/skip", id ? { id } : {});
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Skipped item.`);
        break;
      }

      case "fire": {
        const target = filteredArgs[1];
        let res: any;
        if (target) {
          res = await post(`/api/v1/rundown/fire/${encodeURIComponent(target)}`);
        } else {
          res = await post("/api/v1/rundown/fire");
        }
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Fired line/item '${target ?? "current"}'.`);
        break;
      }

      case "reset": {
        const res = await post("/api/v1/rundown/reset");
        console.log(jsonMode ? JSON.stringify(res, null, 2) : "Reset rundown.");
        break;
      }

      case "cues":
      case "cue": {
        const sub = filteredArgs[1]?.toLowerCase();
        let res: any;
        if (sub === "on" || sub === "enable" || sub === "1") {
          res = await post("/api/v1/cues/enable");
        } else if (sub === "off" || sub === "disable" || sub === "0") {
          res = await post("/api/v1/cues/disable");
        } else {
          res = await post("/api/v1/cues/toggle");
        }
        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          const stateStr = res.cueEngineEnabled ? "ENABLED (Auto cues active)" : "DISABLED (Pure human control mode)";
          console.log(`Cue engine is now: ${stateStr}`);
        }
        break;
      }

      case "vars": {
        const res = await get("/api/v1/variables");
        if (jsonMode) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("\nVariables:");
          for (const [k, v] of Object.entries((res as any).variables ?? {})) {
            console.log(`  ${k.padEnd(20)} = ${v}`);
          }
        }
        break;
      }

      case "set": {
        const name = filteredArgs[1];
        const value = filteredArgs[2];
        if (!name || value === undefined) {
          console.error("Error: Usage: pirundown set <name> <value>");
          process.exit(1);
        }
        const res = await post("/api/v1/variables/set", { name, value });
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Set '${name}' = '${value}'.`);
        break;
      }

      case "transcript": {
        const text = filteredArgs.slice(1).join(" ");
        if (!text) {
          console.error("Error: Missing text.");
          process.exit(1);
        }
        const res = await post("/api/v1/test/transcript", { text });
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Transcript evaluated. Matched: ${(res as any).matched}`);
        break;
      }

      case "sound": {
        const event = filteredArgs[1];
        if (!event) {
          console.error("Error: Usage: pirundown sound <music_start|music_stop|silence>");
          process.exit(1);
        }
        const res = await post("/api/v1/test/sound", { event });
        console.log(jsonMode ? JSON.stringify(res, null, 2) : `Sound event evaluated. Matched: ${(res as any).matched}`);
        break;
      }

      default:
        console.error(`Unknown command: '${command}'`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error("CLI error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void runCli();
