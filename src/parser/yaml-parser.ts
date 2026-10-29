import { parse } from "yaml";
import { RundownV2Schema, type RundownV2 } from "../schema/rundown-v2.js";
import { readFileSync } from "node:fs";

export interface ParseResult {
  ok: boolean;
  data?: RundownV2;
  errors?: string[];
}

export function parseRundownYaml(yamlString: string): ParseResult {
  let raw: unknown;
  try {
    raw = parse(yamlString);
  } catch (err) {
    return {
      ok: false,
      errors: [`YAML Syntax Error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      errors: ["YAML document must be an object at root level."],
    };
  }

  const result = RundownV2Schema.safeParse(raw);
  if (!result.success) {
    const formatted = result.error.errors.map((e) => {
      const path = e.path.join(".");
      return `At '${path || "root"}': ${e.message} (received: ${JSON.stringify(e)})`;
    });
    return {
      ok: false,
      errors: formatted,
    };
  }

  return {
    ok: true,
    data: result.data,
  };
}

export function loadRundownFile(filePath: string): ParseResult {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseRundownYaml(content);
  } catch (err) {
    return {
      ok: false,
      errors: [`Failed to read file '${filePath}': ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
