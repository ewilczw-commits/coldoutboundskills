/**
 * Shared utilities for instantly-inbox-manager scripts.
 *
 * Verification status: account LISTING (GET /accounts) and the account object schema
 * were verified against Instantly's live OpenAPI spec. Account MUTATIONS (warmup,
 * signature, tags) are built from the same verified spec but could not be tested
 * against a real account, because the workspace used to build this had zero connected
 * email accounts. Test against one real account before running any of these at scale.
 */

export const API_BASE = "https://api.instantly.ai/api/v2";
export const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: INSTANTLY_API_KEY");
  process.exit(1);
}

function authHeaders(extra?: Record<string, string>) {
  return { Authorization: `Bearer ${API_KEY}`, ...(extra ?? {}) };
}

export function parseFlag(args: string[], flag: string, defaultValue?: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : defaultValue;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// Instantly identifies accounts by EMAIL, not a numeric/UUID id (verified: GET/PATCH/DELETE
// /accounts/{email} all take the email as the path param, and the Account object has no
// separate id field). Where the Smartlead version of this skill uses --ids=1,2,3 (numeric
// Smartlead ids), this version uses --emails=a@x.com,b@y.com for the same purpose.
export interface InstantlyAccount {
  email: string;
  first_name?: string;
  last_name?: string;
  status?: number; // -3 Sending Error, -2 Soft Bounce, -1 Connection Error, 1 Active, 2 Paused, 3 Maintenance
  warmup_status?: number; // -3 Permanent Suspension, -2 Spam Folder Unknown, -1 Banned, 0 Paused, 1 Active
  stat_warmup_score?: number | null;
  warmup?: {
    limit?: number;
    reply_rate?: number;
    increment?: string; // "disabled" | "0".."4"
    advanced?: Record<string, unknown>;
  };
  daily_limit?: number | null;
  signature?: string | null;
  tags?: { id: string; label: string; description?: string | null }[];
  timestamp_updated?: string;
  timestamp_created?: string;
  [key: string]: any;
}

export async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, { ...options, headers: authHeaders(options?.headers as Record<string, string>) });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry ${attempt + 1}/5 in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }
  throw new Error("Exhausted retries");
}

export async function listAllAccounts(): Promise<InstantlyAccount[]> {
  const all: InstantlyAccount[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ limit: "100", include_tags: "true" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const page = await fetchJson(`${API_BASE}/accounts?${qs.toString()}`);
    const items: InstantlyAccount[] = page?.items ?? [];
    all.push(...items);
    if (!page?.next_starting_after || items.length < 100) break;
    startingAfter = page.next_starting_after;
  }
  return all;
}

/**
 * Given selector args, return the filtered list of accounts.
 *
 * Supported flags:
 *   --all
 *   --emails=a@x.com,b@y.com
 *   --domain=example.com
 *   --tag=active
 *   --emails-from-csv=path (expects header `email` column)
 */
export async function selectAccounts(args: string[]): Promise<InstantlyAccount[]> {
  const all = await listAllAccounts();

  if (hasFlag(args, "--all")) return all;

  const emails = parseFlag(args, "--emails");
  if (emails) {
    const emailSet = new Set(emails.split(",").map((x) => x.trim().toLowerCase()));
    return all.filter((a) => emailSet.has(a.email.toLowerCase()));
  }

  const domain = parseFlag(args, "--domain");
  if (domain) {
    return all.filter((a) => a.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`));
  }

  const tag = parseFlag(args, "--tag");
  if (tag) {
    return all.filter((a) => (a.tags ?? []).some((t) => t.label === tag));
  }

  const csv = parseFlag(args, "--emails-from-csv");
  if (csv) {
    const { readFileSync } = require("fs");
    const text = readFileSync(csv, "utf8");
    const lines = text.trim().split("\n");
    const header = lines[0].split(",");
    const emailCol = header.indexOf("email");
    if (emailCol < 0) throw new Error(`CSV ${csv} missing 'email' column`);
    const emailSet = new Set(lines.slice(1).map((l: string) => l.split(",")[emailCol].trim().toLowerCase()));
    return all.filter((a) => emailSet.has(a.email.toLowerCase()));
  }

  console.error("No selector provided. Use --all, --emails=..., --domain=..., --tag=..., or --emails-from-csv=path");
  process.exit(1);
}

// Resolve a tag label to its id, creating the tag if it doesn't exist yet. Tags in
// Instantly are workspace-level objects (POST /custom-tags), not free-text strings.
export async function resolveOrCreateTag(label: string): Promise<string> {
  const qs = new URLSearchParams({ limit: "100", search: label });
  const page = await fetchJson(`${API_BASE}/custom-tags?${qs.toString()}`);
  const existing = (page?.items ?? []).find((t: any) => t.label === label);
  if (existing) return existing.id;
  const created = await fetchJson(`${API_BASE}/custom-tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  return created.id;
}

/**
 * Assign or unassign a tag (by label) to/from a set of accounts (by email).
 *
 * VERIFIED: resource_ids for resource_type=1 (Account) are email address strings.
 * The API docs don't state this explicitly ("A resource id is the id of an account or
 * a campaign" — no further detail), so this was confirmed empirically: calling this
 * endpoint with a fake email returns `{"statusCode":404,"message":"1 account(s) not
 * found"}` — a not-found error, not a format-validation error — meaning the API
 * accepted the email as a well-formed identifier and simply couldn't find a match.
 * (Still not tested against a REAL account, since this workspace had zero connected
 * accounts at build time — only the identifier format is confirmed, not a full
 * successful assign/unassign round-trip.)
 */
export async function toggleAccountTag(emails: string[], tagLabel: string, assign: boolean): Promise<void> {
  const tagId = await resolveOrCreateTag(tagLabel);
  await fetchJson(`${API_BASE}/custom-tags/toggle-resource`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_ids: [tagId], resource_type: 1, resource_ids: emails, assign }),
  });
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.map((item, idx) => ({ item, idx }));
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const { item, idx } = queue.shift()!;
      try {
        results[idx] = await worker(item, idx);
      } catch (err) {
        results[idx] = { error: String(err) } as any;
      }
    }
  });
  await Promise.all(runners);
  return results;
}
