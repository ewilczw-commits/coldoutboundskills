#!/usr/bin/env tsx
/**
 * Upload a variants.yaml + leads.csv to Instantly as a DRAFT campaign.
 *
 * ALWAYS creates in DRAFT (Instantly's status=0). No --activate flag. Review in the
 * Instantly UI and press Start manually. Mirrors /smartlead-campaign-upload-public's
 * upload.ts — same variants.yaml schema, same leads.csv schema, same DRAFT-only
 * philosophy. See that skill's references/leads-csv-schema.md for the CSV spec.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/upload.ts \
 *     --leads=path/to/leads.csv \
 *     --variants=path/to/variants.yaml
 *
 * Everything verified live against the Instantly v2 API before shipping this script.
 * Two real, non-obvious API quirks discovered and handled here:
 *
 * 1. TIMEZONE ALIASING: Instantly's campaign_schedule.schedules[].timezone accepts
 *    only ~102 specific IANA strings — a deduped list, not the full IANA database.
 *    Common US zone names are REJECTED even though they're valid IANA: "America/New_York"
 *    returns a 400. The correct substitutes (verified live):
 *      America/New_York    -> America/Detroit   (identical rules, different label)
 *      America/Denver      -> America/Boise     (identical rules, different label)
 *      America/Phoenix     -> America/Creston   (fixed MST, no DST, identical rules)
 *      America/Chicago     -> America/Chicago   (no change needed)
 *      America/Los_Angeles -> NO EQUIVALENT EXISTS in Instantly's enum (confirmed by
 *        exhaustive check of the full 102-value list). If your variants.yaml specifies
 *        a Pacific-time zone, this script errors out rather than silently picking a
 *        wrong-offset substitute — pick the closest available zone manually and adjust
 *        start_hour/end_hour by the offset difference, or contact Instantly support.
 *
 * 2. BODY HTML STRIPPING: a bare `<br/>` or `<br>` mixed with un-wrapped plain text in
 *    a step's `body` field gets silently stripped by Instantly's API — everything except
 *    the tag itself disappears. `<br/>` only survives inside a block element (`<div>`,
 *    `<p>`). This script always wraps multi-line bodies in `<div>...</div>` with `<br/>`
 *    between lines to avoid data loss.
 */

import { readFileSync } from "fs";

const API = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

const LEADS_BATCH = 100;

// Same allowlist as smartlead-campaign-upload-public/scripts/upload.ts — keep in sync.
const REQUIRED_COLS = ["email", "first_name", "last_name", "company_name"];
const ALLOWED_COLS = new Set([
  ...REQUIRED_COLS,
  "company_domain",
  "title",
  "linkedin_url",
  "situation_line",
  "value_line",
  "cta_line",
]);

// Verified live against POST /api/v2/campaigns — see header comment for how this list
// was derived. Source of truth: GET https://developer.instantly.ai/api-reference/openapi.json
// -> components.schemas.def-1.properties.campaign_schedule.properties.schedules.items
//    .properties.timezone.enum
const TIMEZONE_ALIASES: Record<string, string> = {
  "America/New_York": "America/Detroit",
  "America/Denver": "America/Boise",
  "America/Phoenix": "America/Creston",
};
const NO_EQUIVALENT_TIMEZONES = new Set(["America/Los_Angeles", "America/Vancouver", "America/Tijuana"]);

// ---------- arg parsing ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    leads: get("--leads"),
    variants: get("--variants"),
  };
}

// ---------- CSV parsing (identical to smartlead-campaign-upload-public) ----------

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cols = parseCsvLine(l);
    const r: Record<string, string> = {};
    headers.forEach((h, i) => (r[h] = (cols[i] ?? "").trim()));
    return r;
  });
  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------- minimal YAML parser (identical to smartlead-campaign-upload-public) ----------
// Supports the subset we need: nested maps, lists of maps, scalars, array literals [1,2,3].

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

function parseYaml(text: string): YamlValue {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cleaned: { indent: number; content: string }[] = [];
  for (const raw of lines) {
    let line = raw;
    let inQuote: string | null = null;
    let commentAt = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === inQuote && line[i - 1] !== "\\") inQuote = null;
      } else {
        if (c === '"' || c === "'") inQuote = c;
        else if (c === "#") { commentAt = i; break; }
      }
    }
    if (commentAt >= 0) line = line.slice(0, commentAt);
    const trimmedRight = line.replace(/\s+$/, "");
    if (!trimmedRight.trim()) continue;
    const indent = trimmedRight.search(/\S/);
    cleaned.push({ indent, content: trimmedRight.slice(indent) });
  }

  let idx = 0;
  function parseBlock(parentIndent: number): YamlValue {
    if (idx >= cleaned.length) return null;
    const firstIndent = cleaned[idx].indent;
    if (firstIndent <= parentIndent) return null;
    if (cleaned[idx].content.startsWith("- ")) return parseList(firstIndent);
    return parseMap(firstIndent);
  }

  function parseMap(indent: number): Record<string, YamlValue> {
    const obj: Record<string, YamlValue> = {};
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`Unexpected indent on line: ${line.content}`);
      const content = line.content;
      const colonIdx = findColon(content);
      if (colonIdx === -1) throw new Error(`Expected key: value, got: ${content}`);
      const key = content.slice(0, colonIdx).trim();
      const afterColon = content.slice(colonIdx + 1).trim();
      idx++;
      if (afterColon === "") obj[key] = parseBlock(indent);
      else obj[key] = parseScalar(afterColon);
    }
    return obj;
  }

  function parseList(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent || !line.content.startsWith("- ")) break;
      const afterDash = line.content.slice(2);
      idx++;
      if (afterDash.trim() === "") { arr.push(parseBlock(indent)); continue; }
      const colonIdx = findColon(afterDash);
      if (colonIdx !== -1 && !afterDash.trim().startsWith('"') && !afterDash.trim().startsWith("'")) {
        const key = afterDash.slice(0, colonIdx).trim();
        const afterKey = afterDash.slice(colonIdx + 1).trim();
        const obj: Record<string, YamlValue> = {};
        if (afterKey === "") obj[key] = parseBlock(indent + 2);
        else obj[key] = parseScalar(afterKey);
        while (idx < cleaned.length) {
          const nl = cleaned[idx];
          if (nl.indent <= indent) break;
          if (nl.content.startsWith("- ")) break;
          const ci = findColon(nl.content);
          if (ci === -1) break;
          const k2 = nl.content.slice(0, ci).trim();
          const v2 = nl.content.slice(ci + 1).trim();
          idx++;
          if (v2 === "") obj[k2] = parseBlock(nl.indent);
          else obj[k2] = parseScalar(v2);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(afterDash));
      }
    }
    return arr;
  }

  return parseBlock(-1);
}

function findColon(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote && s[i - 1] !== "\\") inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ":") return i;
    }
  }
  return -1;
}

function parseScalar(s: string): YamlValue {
  const t = s.trim();
  if (!t) return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return t;
}

// ---------- Instantly API helpers ----------

async function iPost(path: string, body: any): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    if (resp.status === 429 || resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`POST ${path} -> ${resp.status}: ${t.slice(0, 300)}`);
    }
    return resp.json();
  }
  throw new Error(`Exhausted retries for POST ${path}`);
}

async function iGet(path: string): Promise<any> {
  const resp = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`GET ${path} -> ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

async function iDelete(path: string): Promise<void> {
  await fetch(`${API}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${API_KEY}` } });
}

async function listAccounts(): Promise<any[]> {
  const all: any[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ limit: "100", include_tags: "true" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const page = await iGet(`/accounts?${qs.toString()}`);
    const items = page?.items ?? [];
    all.push(...items);
    if (!page?.next_starting_after || items.length < 100) break;
    startingAfter = page.next_starting_after;
  }
  return all;
}

// ---------- validation ----------

function validateVariants(v: any): void {
  if (!v || typeof v !== "object") throw new Error("variants.yaml must be a map at the top level");
  if (!v.name) throw new Error("variants.yaml: `name` is required");
  if (!v.schedule) throw new Error("variants.yaml: `schedule` is required");
  if (!v.inbox_selection?.tag) throw new Error("variants.yaml: `inbox_selection.tag` is required");
  if (!Number.isFinite(v.inbox_selection?.count)) throw new Error("variants.yaml: `inbox_selection.count` must be a number");
  if (!Array.isArray(v.sequences) || !v.sequences.length) throw new Error("variants.yaml: `sequences` must be a non-empty array");
  for (const seq of v.sequences) {
    if (!Number.isFinite(seq.step)) throw new Error("sequences[].step must be a number");
    if (!Number.isFinite(seq.delay_days)) throw new Error("sequences[].delay_days must be a number");
    if (!Array.isArray(seq.variants) || !seq.variants.length) throw new Error("sequences[].variants must be a non-empty array");
    for (const variant of seq.variants) {
      if (!variant.label) throw new Error("sequences[].variants[].label required");
      if (typeof variant.subject !== "string") throw new Error("sequences[].variants[].subject must be a string (empty string OK for threaded follow-ups)");
      if (typeof variant.body !== "string" || !variant.body) throw new Error("sequences[].variants[].body is required and non-empty");
    }
  }
}

function validateCsvSchema(headers: string[]): void {
  const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
  if (missing.length) throw new Error(`leads.csv missing required columns: ${missing.join(", ")}`);
  const extras = headers.filter((h) => !ALLOWED_COLS.has(h));
  if (extras.length) {
    throw new Error(
      `leads.csv has unallowed columns: ${extras.join(", ")}.\n` +
      `See /smartlead-campaign-upload-public/references/leads-csv-schema.md for the spec (shared with this script).`
    );
  }
}

function resolveTimezone(tz: string): string {
  if (TIMEZONE_ALIASES[tz]) return TIMEZONE_ALIASES[tz];
  if (NO_EQUIVALENT_TIMEZONES.has(tz)) {
    throw new Error(
      `Instantly has no timezone equivalent for "${tz}" (confirmed by testing the full enum live — ` +
      `Pacific-time zones aren't represented at all). Pick a different zone in variants.yaml and adjust ` +
      `start_hour/end_hour manually, or split the campaign by hand in the Instantly UI.`
    );
  }
  return tz; // pass through — may still be valid; Instantly will 400 with a clear error if not
}

// Wrap body content so a mid-text <br/> can't get silently stripped by Instantly's API
// (see header comment, quirk #2). Safe for both plain-text and already-HTML input.
function wrapBody(body: string): string {
  const withBreaks = body.replace(/\r\n/g, "\n").split("\n").join("<br/>");
  return `<div>${withBreaks}</div>`;
}

// Mon=1..Sun=7 (variants.yaml convention) -> Instantly's "0"=Sun.."6"=Sat map
function daysToInstantly(days: number[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const d of days) {
    const key = d === 7 ? "0" : String(d);
    map[key] = true;
  }
  return map;
}

// ---------- main ----------

async function main() {
  const args = parseArgs();
  if (!args.leads || !args.variants) {
    console.error("Usage: --leads=<path> --variants=<path>");
    process.exit(1);
  }

  console.error(`Loading leads from ${args.leads}...`);
  const csvText = readFileSync(args.leads, "utf8");
  const { headers, rows: leads } = parseCsv(csvText);
  validateCsvSchema(headers);
  console.error(`  ${leads.length} leads, columns: ${headers.join(", ")}`);

  console.error(`Loading variants from ${args.variants}...`);
  const variantsYaml = readFileSync(args.variants, "utf8");
  const v = parseYaml(variantsYaml) as any;
  validateVariants(v);
  const variantCount = v.sequences.reduce((s: number, seq: any) => s + seq.variants.length, 0);
  console.error(`  ${v.sequences.length} sequences, ${variantCount} total variants`);

  // Select inboxes by tag first, so a bad tag fails fast before we create anything.
  console.error(`Selecting inboxes tagged "${v.inbox_selection.tag}"...`);
  const allAccounts = await listAccounts();
  const tagged = allAccounts.filter((a: any) =>
    (a.tags ?? []).some((t: any) => t.label === v.inbox_selection.tag) &&
    a.status === 1 && // Active (per Instantly's status enum: -3..3, 1=Active)
    a.warmup_status !== -1 && a.warmup_status !== -3 // not Banned / not Permanently Suspended
  );
  // Instantly's account list doesn't expose a per-day sent-count field the way Smartlead's
  // daily_sent_count does — timestamp_updated (least-recently-touched first) is used here as
  // an LRU proxy. This is an approximation, not a true send-volume LRU like the Smartlead version.
  tagged.sort((a: any, b: any) => new Date(a.timestamp_updated ?? 0).getTime() - new Date(b.timestamp_updated ?? 0).getTime());
  const selected = tagged.slice(0, v.inbox_selection.count);
  if (!selected.length) {
    throw new Error(`No healthy accounts found tagged "${v.inbox_selection.tag}". Run /instantly-inbox-manager to tag accounts first.`);
  }
  if (selected.length < v.inbox_selection.count) {
    console.error(`  Only ${selected.length} accounts matched (requested ${v.inbox_selection.count}). Proceeding with what's available.`);
  }
  const emailList = selected.map((a: any) => a.email);
  console.error(`  ${emailList.length} inboxes selected (tag=${v.inbox_selection.tag})`);

  // Build the single POST /campaigns body — schedule + sequences + email_list all in one
  // call (unlike Smartlead, which needs separate /sequences, /email-accounts, /schedule calls).
  const timezone = resolveTimezone(v.schedule.timezone);
  const days = Array.isArray(v.schedule.days) ? v.schedule.days.map(Number) : [1, 2, 3, 4, 5];

  const campaignBody: any = {
    name: v.name,
    campaign_schedule: {
      schedules: [
        {
          name: "default",
          timing: { from: v.schedule.start_hour, to: v.schedule.end_hour },
          days: daysToInstantly(days),
          timezone,
        },
      ],
    },
    sequences: [
      {
        steps: v.sequences.map((seq: any) => ({
          type: "email",
          delay: seq.delay_days,
          delay_unit: "days",
          variants: seq.variants.map((va: any) => ({
            subject: (va.subject || "").replace(/—/g, " - ").replace(/–/g, " - "),
            body: wrapBody(va.body),
          })),
        })),
      },
    ],
    email_list: emailList,
    daily_max_leads: v.schedule.max_leads_per_day,
    email_gap: v.schedule.min_time_btw_emails,
    stop_on_reply: true,
    open_tracking: false,
    link_tracking: false,
  };

  console.error(`Creating Instantly campaign "${v.name}"...`);
  const created = await iPost("/campaigns", campaignBody);
  const campaignId = created.id;
  if (!campaignId) throw new Error(`Campaign create failed: ${JSON.stringify(created)}`);
  if (created.status !== 0) {
    console.error(`  WARNING: expected DRAFT (status=0) but got status=${created.status}. Review before proceeding.`);
  }
  console.error(`  Campaign ${campaignId} created (status=${created.status} = Draft)`);

  // Upload leads in batches via POST /leads/add (verified live — max 1000/batch, we use 100
  // for parity with the Smartlead script's batch size and gentler rate-limit behavior).
  let uploaded = 0;
  let duplicates = 0;
  for (let i = 0; i < leads.length; i += LEADS_BATCH) {
    const batch = leads.slice(i, i + LEADS_BATCH).map((l) => {
      const custom_variables: Record<string, string> = {};
      for (const h of headers) {
        if (["email", "first_name", "last_name", "company_name", "title"].includes(h)) continue;
        if (l[h]) custom_variables[h] = l[h];
      }
      return {
        email: l.email,
        first_name: l.first_name || "",
        last_name: l.last_name || "",
        company_name: l.company_name || "",
        job_title: l.title || "",
        custom_variables,
      };
    });
    try {
      const result = await iPost("/leads/add", { campaign_id: campaignId, leads: batch });
      uploaded += result.leads_uploaded ?? 0;
      duplicates += result.duplicated_leads ?? 0;
      process.stdout.write(`  ${uploaded}/${leads.length} leads uploaded\r`);
    } catch (err: any) {
      console.error(`\n  batch ${i}-${i + LEADS_BATCH} failed: ${err.message?.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`\n  ${uploaded} leads uploaded${duplicates ? ` (${duplicates} duplicates skipped)` : ""}`);

  console.log(``);
  console.log(`Campaign ${campaignId} created in DRAFT`);
  console.log(``);
  console.log(`Review + Start:`);
  console.log(`  -> https://app.instantly.ai/app/campaign/${campaignId}`);
  console.log(``);
  console.log(`This script does NOT auto-activate. Review the campaign in the Instantly UI and hit Start when satisfied.`);
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
