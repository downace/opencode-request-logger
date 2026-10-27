import { Plugin } from "@opencode/plugin";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface LoggerOptions {
  enabled?: boolean;
  directory?: string;
}

interface RequestMeta {
  source: "http" | "fetch" | "websocket";
  url: string;
  kind?: string;
  agent?: string;
  model?: string;
}

const DEFAULT_ROOT = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "logs",
  "request-logger",
);

const DEDUPE_WINDOW_MS = 30_000;
const DEDUPE_MAX_ENTRIES = 512;

const state = {
  root: DEFAULT_ROOT,
  sequence: 0,
  sessionID: "unknown",
  seen: new Map<string, number>(),
  fetchPatched: false,
  originalFetch: undefined as typeof globalThis.fetch | undefined,
};

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function isAiRequestBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;
  if (Array.isArray(candidate.messages)) return true;
  if (Array.isArray(candidate.input) || typeof candidate.input === "string") return true;
  if (Array.isArray(candidate.contents) || typeof candidate.contents === "string") return true;
  return false;
}

function hasAiPayload(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasAiPayload(item, depth + 1));
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "messages" || key === "input" || key === "contents") return true;
    if (hasAiPayload(item, depth + 1)) return true;
  }
  return false;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(url: string, body: unknown): string {
  return createHash("sha256").update(url).update("\u0000").update(canonicalize(body)).digest("hex");
}

function markSeen(key: string): boolean {
  const now = Date.now();
  if (state.seen.size >= DEDUPE_MAX_ENTRIES) {
    for (const [entry, at] of state.seen) {
      if (now - at > DEDUPE_WINDOW_MS) state.seen.delete(entry);
    }
  }
  const previous = state.seen.get(key);
  state.seen.set(key, now);
  return previous !== undefined && now - previous <= DEDUPE_WINDOW_MS;
}

function write(sessionID: string, meta: RequestMeta, body: unknown): void {
  try {
    const dir = join(state.root, sanitizeSegment(sessionID));
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const seq = String(state.sequence++).padStart(4, "0");
    const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${seq}.json`);
    const entry = {
      timestamp,
      url: meta.url,
      source: meta.source,
      kind: meta.kind,
      agent: meta.agent,
      model: meta.model,
      body,
    };
    writeFileSync(file, JSON.stringify(entry, null, 2));
  } catch {
    // Never let logging break the actual request
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function readRequestBody(request: Request): Promise<string> {
  try {
    return await request.clone().text();
  } catch {
    return "";
  }
}

function record(sessionID: string, meta: RequestMeta, raw: string): void {
  const body = parseJson(raw);
  if (body === undefined) return;
  if (!isAiRequestBody(body)) return;
  if (markSeen(fingerprint(meta.url, body))) return;
  write(sessionID, meta, body);
}

function resolveUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return "unknown";
}

function installFetchWrapper(): void {
  if (state.fetchPatched) return;
  const original = globalThis.fetch;
  state.originalFetch = original;
  globalThis.fetch = async (input, init) => {
    const body = init?.body;
    if (typeof body === "string") {
      record(state.sessionID, { source: "fetch", url: resolveUrl(input) }, body);
    }
    return original(input, init);
  };
  state.fetchPatched = true;
}

function restoreFetch(): void {
  if (!state.fetchPatched) return;
  if (state.originalFetch) globalThis.fetch = state.originalFetch;
  state.originalFetch = undefined;
  state.fetchPatched = false;
}

export default Plugin.define({
  id: "opencode-request-logger",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as LoggerOptions;
    if (options.enabled === false) return;

    state.root = options.directory ? resolve(options.directory) : DEFAULT_ROOT;

    await ctx.session.hook("http.request", async (event) => {
      state.sessionID = event.sessionID;
      record(
        event.sessionID,
        {
          source: "http",
          url: event.request.url,
          kind: event.kind,
          agent: event.agent,
          model: `${event.model.providerID}/${event.model.id}`,
        },
        await readRequestBody(event.request),
      );
    });

    await ctx.session.hook("context", (event) => {
      state.sessionID = event.sessionID;
    });

    await ctx.session.hook("experimental.ws.send", (event) => {
      state.sessionID = event.sessionID;
      const frame = parseJson(event.frame);
      if (frame === undefined || !hasAiPayload(frame)) return;
      write(
        event.sessionID,
        {
          source: "websocket",
          url: "websocket",
          kind: event.kind,
          agent: event.agent,
          model: `${event.model.providerID}/${event.model.id}`,
        },
        frame,
      );
    });

    installFetchWrapper();

    return () => {
      restoreFetch();
    };
  },
});
