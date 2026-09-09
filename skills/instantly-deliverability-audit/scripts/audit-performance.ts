#!/usr/bin/env tsx
/**
 * Campaign-level sent/reply/bounce audit — applies the 1% rule.
 *
 * SIMPLER than the Smartlead version: Instantly's GET /campaigns/analytics accepts a
 * batch of campaign ids and returns emails_sent_count/reply_count/bounced_count per
 * campaign in ONE call — no per-campaign round trip needed.
 *
 * DROPPED vs Smartlead version: the "best-effort per-inbox aggregation" (Smartlead's
 * mailbox-statistics + email-accounts-per-campaign join). Instantly doesn't expose an
 * equivalent per-inbox-per-campaign breakdown in this API; GET /accounts/analytics/daily
 * gives per-account volume but not scoped to a single campaign. Campaign-level is the
 * authoritative signal anyway (per the Smartlead script's own comment) — if you need
 * per-inbox detail, extend this script against /accounts/analytics/daily yourself.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/audit-performance.ts --out=/tmp/audit/performance
 *   npx tsx scripts/audit-performance.ts --campaign-ids=<uuid1>,<uuid2> --out=/tmp/audit/perf
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

const LOW_REPLY_THRESHOLD = 1.0;
const LOW_REPLY_MIN_SENT = 200;
const HIGH_BOUNCE_THRESHOLD = 3.0;
const HIGH_BOUNCE_MIN_SENT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    out: get("--out") ?? "/tmp/audit/performance",
    maxCampaigns: get("--max-campaigns") ? Number(get("--max-campaigns")) : Infinity,
    campaignIds: get("--campaign-ids")?.split(",").map((s) => s.trim()),
  };
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (resp.status === 429 || resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${resp.status}: ${t.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error("exhausted retries");
}

async function listCampaigns(): Promise<any[]> {
  const all: any[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const page = await fetchJson(`${API_BASE}/campaigns?${qs.toString()}`);
    const items = page?.items ?? [];
    all.push(...items);
    if (!page?.next_starting_after || items.length < 100) break;
    startingAfter = page.next_starting_after;
  }
  return all;
}

async function campaignsAnalytics(ids: string[]): Promise<any[]> {
  const qs = new URLSearchParams();
  for (const id of ids) qs.append("ids", id);
  const data = await fetchJson(`${API_BASE}/campaigns/analytics?${qs.toString()}`);
  return Array.isArray(data) ? data : [];
}

interface CampaignRow {
  campaign_id: string;
  name: string;
  status: string;
  sent: number;
  replies: number;
  bounces: number;
  reply_rate_pct: number;
  bounce_rate_pct: number;
  flag_low_reply: boolean;
  flag_high_bounce: boolean;
}

function toCsv<T>(rows: T[], headers: string[]): string {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => `"${String((r as any)[h] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const { out, maxCampaigns, campaignIds } = parseArgs();

  let ids: string[];
  let nameById = new Map<string, string>();
  let statusById = new Map<string, string>();
  if (campaignIds?.length) {
    ids = campaignIds;
    console.error(`${ids.length} campaigns (from --campaign-ids)`);
  } else {
    const all = await listCampaigns();
    // status: 0 Draft, 1 Active, 2 Paused, 3 Completed, 4 Running Subsequences, negative = error states
    const relevant = all.filter((c) => [1, 2, 3, 4].includes(c.status));
    const limited = isFinite(maxCampaigns) ? relevant.slice(0, maxCampaigns) : relevant;
    ids = limited.map((c) => c.id);
    for (const c of limited) {
      nameById.set(c.id, c.name);
      statusById.set(c.id, String(c.status));
    }
    console.error(`${ids.length} active/paused/completed campaigns`);
  }

  if (!ids.length) {
    console.error("No campaigns to audit.");
    return;
  }

  // Batch in groups of 100 (a conservative cap — the API doc doesn't state a hard limit
  // on the ids array, but batching avoids an unwieldy query string for large fleets).
  const campaignRows: CampaignRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const analytics = await campaignsAnalytics(batch);
    for (const a of analytics) {
      const sent = Number(a.emails_sent_count ?? 0);
      const replies = Number(a.reply_count ?? 0);
      const bounces = Number(a.bounced_count ?? 0);
      const replyRate = sent ? (replies / sent) * 100 : 0;
      const bounceRate = sent ? (bounces / sent) * 100 : 0;
      campaignRows.push({
        campaign_id: a.campaign_id,
        name: a.campaign_name || nameById.get(a.campaign_id) || "",
        status: String(a.campaign_status ?? statusById.get(a.campaign_id) ?? ""),
        sent,
        replies,
        bounces,
        reply_rate_pct: Number(replyRate.toFixed(2)),
        bounce_rate_pct: Number(bounceRate.toFixed(2)),
        flag_low_reply: sent >= LOW_REPLY_MIN_SENT && replyRate < LOW_REPLY_THRESHOLD,
        flag_high_bounce: sent >= HIGH_BOUNCE_MIN_SENT && bounceRate > HIGH_BOUNCE_THRESHOLD,
      });
    }
    console.error(`  ${Math.min(i + 100, ids.length)}/${ids.length} analytics pulled`);
  }
  campaignRows.sort((a, b) => b.sent - a.sent);

  mkdirSync(dirname(out), { recursive: true });
  const headers = ["campaign_id", "name", "status", "sent", "replies", "bounces", "reply_rate_pct", "bounce_rate_pct", "flag_low_reply", "flag_high_bounce"];
  writeFileSync(`${out}-campaigns.csv`, toCsv(campaignRows, headers));

  const totalSent = campaignRows.reduce((s, c) => s + c.sent, 0);
  const totalReplies = campaignRows.reduce((s, c) => s + c.replies, 0);
  const totalBounces = campaignRows.reduce((s, c) => s + c.bounces, 0);
  const fleetReply = totalSent ? (totalReplies / totalSent) * 100 : 0;
  const fleetBounce = totalSent ? (totalBounces / totalSent) * 100 : 0;
  const camp1pct = campaignRows.filter((c) => c.flag_low_reply).length;
  const campHiBounce = campaignRows.filter((c) => c.flag_high_bounce).length;

  console.log(`\n=== Fleet Performance Summary ===\n`);
  console.log(`Campaigns audited:       ${campaignRows.length}`);
  console.log(`Total sent:              ${totalSent.toLocaleString()}`);
  console.log(`Total replies:           ${totalReplies.toLocaleString()}`);
  console.log(`Total bounces:           ${totalBounces.toLocaleString()}`);
  console.log(`Fleet reply rate:        ${fleetReply.toFixed(2)}%  ${fleetReply >= 1 ? "PASS" : "FAIL (below 1%)"}`);
  console.log(`Fleet bounce rate:       ${fleetBounce.toFixed(2)}%  ${fleetBounce <= 2 ? "PASS" : "FAIL (above 2%)"}`);
  console.log(`\nCampaigns failing 1% rule (>=200 sent, <1% reply):   ${camp1pct}`);
  console.log(`Campaigns with bounce >3% (>=50 sent):                  ${campHiBounce}`);

  const offenders = campaignRows.filter((c) => c.flag_low_reply).slice(0, 10);
  if (offenders.length) {
    console.log(`\nTop campaigns failing the 1% rule:`);
    for (const o of offenders) {
      console.log(`${o.campaign_id}  sent=${o.sent}  reply=${o.reply_rate_pct}%  ${o.name.slice(0, 60)}`);
    }
  }

  console.log(`\nOutput: ${out}-campaigns.csv`);
  console.log(`(No per-inbox CSV — see header comment for why.)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
