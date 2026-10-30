import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { parseRundownYaml } from "../parser/yaml-parser.js";
import type { RundownV2 } from "../schema/rundown-v2.js";

export interface RundownStorageItem {
  id: string;
  name: string;
  filename: string;
  title?: string;
  service?: string;
  church?: string;
  date?: string;
  itemCount: number;
  modifiedAt: string;
  sizeBytes: number;
}

export interface RundownStorageDetail extends RundownStorageItem {
  yaml: string;
  data?: RundownV2;
}

export interface RundownStorageOptions {
  storageDir?: string;
  seedExamples?: boolean;
}

export class RundownStorage {
  private readonly storageDir: string;

  constructor(optionsOrDir?: string | RundownStorageOptions) {
    if (typeof optionsOrDir === "string") {
      this.storageDir = resolve(optionsOrDir || "storage");
    } else {
      this.storageDir = resolve(optionsOrDir?.storageDir || "storage");
    }
    this.ensureStorageDir();
    if (typeof optionsOrDir === "object" && optionsOrDir.seedExamples) {
      this.seedDefaultExamples();
    }
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private seedDefaultExamples(): void {
    try {
      const files = readdirSync(this.storageDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
      if (files.length === 0) {
        const examplePath = resolve(process.cwd(), "examples", "sunday-mass.yaml");
        if (existsSync(examplePath)) {
          copyFileSync(examplePath, join(this.storageDir, "sunday-mass.yaml"));
        }
      }
    } catch {
      // Best-effort seeding
    }
  }

  private sanitizeId(rawId: string): string {
    const clean = rawId.replace(/\.ya?ml$/i, "").replace(/[^a-zA-Z0-9_\-]/g, "_");
    return clean || "rundown";
  }

  private getFilePath(id: string): string {
    const safeId = this.sanitizeId(id);
    return join(this.storageDir, `${safeId}.yaml`);
  }

  list(): RundownStorageItem[] {
    this.ensureStorageDir();
    const files = readdirSync(this.storageDir);
    const items: RundownStorageItem[] = [];

    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const fullPath = join(this.storageDir, file);
      try {
        const stat = statSync(fullPath);
        const yamlContent = readFileSync(fullPath, "utf-8");
        const parsed = parseRundownYaml(yamlContent);

        const id = basename(file, extname(file));
        const rundownData = parsed.ok ? parsed.data : undefined;

        items.push({
          id,
          name: rundownData?.title || id,
          filename: file,
          title: rundownData?.title,
          service: rundownData?.service,
          church: rundownData?.church,
          date: rundownData?.date,
          itemCount: rundownData?.rundown ? rundownData.rundown.length : 0,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch {
        // Skip unreadable files
      }
    }

    // Sort newest modified first
    return items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  }

  get(id: string): RundownStorageDetail | null {
    this.ensureStorageDir();
    const filePath = this.getFilePath(id);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const stat = statSync(filePath);
      const yaml = readFileSync(filePath, "utf-8");
      const parsed = parseRundownYaml(yaml);
      const rundownData = parsed.ok ? parsed.data : undefined;
      const safeId = this.sanitizeId(id);

      return {
        id: safeId,
        name: rundownData?.title || safeId,
        filename: `${safeId}.yaml`,
        title: rundownData?.title,
        service: rundownData?.service,
        church: rundownData?.church,
        date: rundownData?.date,
        itemCount: rundownData?.rundown ? rundownData.rundown.length : 0,
        modifiedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        yaml,
        data: rundownData,
      };
    } catch {
      return null;
    }
  }

  save(
    rawId: string | undefined,
    yamlContent: string
  ): { ok: boolean; item?: RundownStorageDetail; error?: string } {
    this.ensureStorageDir();
    const parsed = parseRundownYaml(yamlContent);
    if (!parsed.ok || !parsed.data) {
      return { ok: false, error: "Virheellinen Rundown v2 YAML -sisältö: " + parsed.errors?.join(", ") };
    }

    // Infer ID from title/date if rawId not given
    let id = rawId;
    if (!id || id.trim().length === 0) {
      const titleSlug = (parsed.data.title || "rundown").toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
      const datePart = parsed.data.date ? `_${parsed.data.date}` : "";
      id = `${titleSlug}${datePart}`;
    }

    const safeId = this.sanitizeId(id);
    const filePath = this.getFilePath(safeId);

    try {
      writeFileSync(filePath, yamlContent, "utf-8");
      const detail = this.get(safeId);
      return { ok: true, item: detail || undefined };
    } catch (err: any) {
      return { ok: false, error: `Tiedoston tallennus epäonnistui: ${err.message}` };
    }
  }

  delete(id: string): boolean {
    this.ensureStorageDir();
    const filePath = this.getFilePath(id);
    if (!existsSync(filePath)) {
      return false;
    }
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  getStorageDirectory(): string {
    return this.storageDir;
  }
}
