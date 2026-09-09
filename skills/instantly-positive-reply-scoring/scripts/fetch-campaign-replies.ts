#!/usr/bin/env tsx
/**
 * Fetch replies from an Instantly campaign for classification.
 *
 * Simpler than the Smartlead version: Instantly's GET /emails endpoint filters
 * directly by campaign_id + email_type=received, returning the reply body inline —
 * no need to list leads first, then fetch per-lead message history (Smartlead's
 * N+1 pattern). One paginated call gets every inbound reply for the campaign.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/fetch-campaign-replies.ts --campaign-id=<uuid> --out=/tmp/replies.json
 *
 * Optional flags:
 *   --since=YYYY-MM-DD    Only replies after this date (maps to min_timestamp_created)
 *
 * NOTE: Instantly has its own reply metadata (i_status / lt_interest_status enum:
 * 0=Out of Office, 1=Interested, 2=Meeting Booked, 3=Meeting Completed, 4=Won,
 * -1=Not Interested, -2=Wrong Person, -3=Lost, -4=No Show) and even a built-in AI
 * label predictor (POST /lead-labels/test-prediction). This script deliberately does
 * NOT use either — same design decision as the Smartlead version of this skill
 * ("Smartlead's built-in AI categorization exists but is less controllable. This
 * skill uses Claude directly for transparency and prompt-tunable classification.").
 * Both platforms' built-in categorization are bypassed for the same reason.
 *
 * Rate limit: GET /emails is capped at 20 req/min (lower than most Instantly
 * endpoints) — this script paces accordingly.
 */

import { writeFileSync } from "fs";

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: INSTANTLY_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const campaignId = get("--campaign-id");
  const out = get("--out") ?? "/tmp/replies.json";
  const since = get("--since");
  if (!campaignId) {
    console.error("Usage: --campaign-id=<uuid> [--out=path] [--since=YYYY-MM-DD]");
    process.exit(1);
  }
  return { campaignId, out, since };
}

interface Reply {
  lead_id: string;
  email: string;
  lead_first_name: string;
  company: string;
  reply_time: string;
  reply_subject: string;
  reply_body: string;
  sequence_step: number;
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error("Exhausted retries");
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const { campaignId, out, since } = parseArgs();
  console.error(`Fetching received emails for campaign ${campaignId}...`);

  const replies: Reply[] = [];
  let startingAfter: string | undefined;
  let page = 0;

  while (true) {
    const qs = new URLSearchParams({
      limit: "100",
      campaign_id: campaignId,
      email_type: "received",
      sort_order: "asc",
    });
    if (since) qs.set("min_timestamp_created", new Date(since).toISOString());
    if (startingAfter) qs.set("starting_after", startingAfter);

    const data = await fetchJson(`${API_BASE}/emails?${qs.toString()}`);
    const items = data?.items ?? [];
    for (const item of items) {
      const rawBody = item.body?.html || item.body?.text || "";
      replies.push({
        lead_id: item.lead_id || item.lead || "",
        email: item.lead || item.from_address_email || "",
        lead_first_name: "", // not present on the email object — join against leads.csv if needed
        company: "",
        reply_time: item.timestamp_email || item.timestamp_created || "",
        reply_subject: item.subject || "",
        reply_body: stripHtml(rawBody).slice(0, 5000),
        sequence_step: 0, // not exposed on the email object; see campaign step analytics if needed
      });
    }
    page++;
    console.error(`  page ${page}: ${items.length} replies, ${replies.length} total`);
    if (!data?.next_starting_after || items.length < 100) break;
    startingAfter = data.next_starting_after;
    await new Promise((r) => setTimeout(r, 3100)); // 20 req/min rate limit on this endpoint
  }

  writeFileSync(out, JSON.stringify(replies, null, 2));
  console.error(`\nWrote ${out} — ${replies.length} replies`);
  console.error(`Note: lead_first_name/company/sequence_step aren't on Instantly's email object — join against your leads.csv or GET /leads/{id} if you need them for classification context.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
