/**
 * Gateway configuration persistence and normalization.
 *
 * The config file is NON-SECRET: it holds gateway ids, names, base URLs, and
 * optional ambient env-var names. API keys never live here — they are stored
 * by pi's /login in auth.json (0600) or read from the environment at request
 * time.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type GatewayApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface GatewayConfig {
  /** Stable id. Doubles as the pi provider id and the auth.json credential key. */
  id: string;
  /** Human display name. */
  name: string;
  /** Normalized gateway base URL (no trailing slash). */
  baseUrl: string;
  /** Inference protocol. Defaults to openai-completions. */
  api?: GatewayApi;
  /** Optional ambient env var holding the API key (alternative to /login). */
  apiKeyEnv?: string;
  /**
   * Per-gateway compat overrides applied to every discovered model (merged
   * over inherited catalog compat). Use for backend quirks, e.g.
   * { "supportsStore": false } for gateways fronting the strict Mistral API,
   * which rejects the `store` parameter pi sends to unknown endpoints.
   */
  compat?: Record<string, unknown>;
  /** Model ids to never register. */
  excludedModels?: string[];
}

export interface GatewayConfigFile {
  version: 1;
  gateways: GatewayConfig[];
}

export const AGENT_DIR = getAgentDir();
export const CONFIG_PATH = join(AGENT_DIR, "gateway-discovery.json");
export const AUTH_PATH = join(AGENT_DIR, "auth.json");
export const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");

export function isGatewayApi(value: unknown): value is GatewayApi {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages";
}

// ---------------------------------------------------------------------------
// Normalization / validation
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Base URL cannot be empty");

  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not include credentials in the Base URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

/**
 * The base URL pi should use for *inference*. For anthropic-messages we strip
 * a trailing /v1 so the SDK does not generate /v1/v1/messages.
 */
export function inferenceBaseUrlForApi(baseUrl: string, api: GatewayApi): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (api !== "anthropic-messages") return normalized;
  const parsed = new URL(normalized);
  if (parsed.pathname.endsWith("/v1")) {
    parsed.pathname = parsed.pathname.slice(0, -3) || "/";
    return parsed.toString().replace(/\/$/u, "");
  }
  return normalized;
}

export function validateGatewayId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error("Gateway ID may contain lowercase letters, numbers, dots, underscores, and hyphens");
  }
  return id;
}

/** Suggest a readable id/name from the hostname, e.g. yoda.teknologisk.dk → yoda / "Yoda". */
export function suggestGatewayIdentity(
  rawBaseUrl: string,
  existingIds: ReadonlySet<string>,
): { id: string; name: string } {
  const hostname = new URL(normalizeBaseUrl(rawBaseUrl)).hostname.toLowerCase();
  const labels = hostname.split(".").filter(Boolean);
  const generic = new Set([
    "api", "www", "gateway", "proxy", "openai", "anthropic", "ai", "v1",
    "com", "net", "org", "io", "cn", "dk", "local", "localhost",
  ]);
  const brand = labels.find((label) => !generic.has(label)) ?? labels[0] ?? "gateway";
  const baseId = validateGatewayId(brand.replace(/[^a-z0-9._-]+/gu, "-"));
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const readable = brand
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return { id, name: readable || "Gateway" };
}

// ---------------------------------------------------------------------------
// Persistence (atomic, 0600)
// ---------------------------------------------------------------------------

function parseConfigFile(value: unknown): GatewayConfigFile {
  if (!value || typeof value !== "object") throw new Error("Configuration must be a JSON object");
  const input = value as { version?: unknown; gateways?: unknown };
  if (input.version !== 1 || !Array.isArray(input.gateways)) {
    throw new Error("Unsupported gateway-discovery config version");
  }

  const gateways = input.gateways.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid gateway entry #${index + 1}`);
    const item = entry as Partial<GatewayConfig>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.baseUrl !== "string") {
      throw new Error(`Gateway entry #${index + 1} requires id, name, and baseUrl`);
    }
    if (item.api !== undefined && !isGatewayApi(item.api)) {
      throw new Error(`Invalid api for gateway ${item.id}`);
    }
    const excludedModels = Array.isArray(item.excludedModels)
      ? [...new Set(item.excludedModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0))]
      : undefined;
    return {
      id: validateGatewayId(item.id),
      name: item.name.trim() || item.id,
      baseUrl: normalizeBaseUrl(item.baseUrl),
      ...(isGatewayApi(item.api) ? { api: item.api } : {}),
      ...(typeof item.apiKeyEnv === "string" && item.apiKeyEnv.trim() ? { apiKeyEnv: item.apiKeyEnv.trim() } : {}),
      ...(item.compat && typeof item.compat === "object" && !Array.isArray(item.compat)
        ? { compat: item.compat as Record<string, unknown> }
        : {}),
      ...(excludedModels && excludedModels.length > 0 ? { excludedModels } : {}),
    };
  });

  return { version: 1, gateways };
}

export async function loadConfig(): Promise<GatewayConfigFile> {
  try {
    return parseConfigFile(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, gateways: [] };
    throw new Error(`Cannot load ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(next: GatewayConfigFile): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const tempPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, CONFIG_PATH);
    await chmod(CONFIG_PATH, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Remove one key from a JSON object file, preserving unrelated entries (used for auth.json / models-store.json cleanup). */
export async function deleteJsonRecordKey(path: string, key: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) return false;
  delete record[key];

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return true;
}
