/**
 * config.ts — `.flaketriage.yml`: repo defaults that CLI flags
 * override. Loading + reading the file is the only I/O here; validation is a
 * pure zod parse. Only the CLI/Action boundary imports this — never `core/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { FlakeTriageError } from "./core/errors.js";

const ConfigSchema = z.object({
  llm: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      base_url: z.string().optional(),
    })
    .strict()
    .optional(),
  redact: z
    .object({
      patterns: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
});

export type FlakeTriageConfig = z.infer<typeof ConfigSchema>;

export const CONFIG_FILENAMES = [".flaketriage.yml", ".flaketriage.yaml"];

export interface LoadedConfig {
  config: FlakeTriageConfig;
  /** absolute path of the file actually loaded, or null when none exists. */
  path: string | null;
}

const EMPTY: LoadedConfig = { config: {}, path: null };

/**
 * Look for `.flaketriage.yml` / `.flaketriage.yaml` directly under `repoPath`.
 * Returns an empty config (not an error) when neither file exists — the config
 * file is entirely optional.
 */
export function loadConfig(repoPath: string): LoadedConfig {
  for (const name of CONFIG_FILENAMES) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;

    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new FlakeTriageError("CONFIG_INVALID", `${name}: invalid YAML`, { cause });
    }

    const result = ConfigSchema.safeParse(raw ?? {});
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new FlakeTriageError("CONFIG_INVALID", `${name}: ${detail}`);
    }
    return { config: result.data, path };
  }
  return EMPTY;
}
