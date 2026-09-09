#!/usr/bin/env tsx
/**
 * Compare reply/bounce rates by inbox provider type across an Instantly workspace.
 *
 * Alternative to /deliverability-test-public for Instantly users. Groups by
 * provider_code (1=Custom IMAP/SMTP, 2=Google, 3=Microsoft, 4=AWS, 8=AirMail,
 * 11=Airmail Instant) instead of Smartlead's `type` field (GMAIL/OUTLOOK/SMTP).
 *
 * DIFFERENT DATA SOURCE than the Smartlead version: rather than joining per-campaign
 * analytics against inbox lists, this uses GET /accounts/analytics/daily, which gives
 * per-account sent/replies/bounced counts directly (verified live — see field list in
 * the endpoint's docs). This is arguably more accurate than the Smartlead version's
 * per-campaign join, since it's fleet-wide by construction rather than scoped to
 * "campaigns that use these inboxes."
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/inbox-type-compare.ts               # last 7 days, all accounts
 *   npx tsx scripts/inbox-type-compare.ts --days=14
 *
 * Note: GET /accounts/analytics/daily caps at a 31-day range and 200 emails per call —
 * this script batches accordingly.
 */

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

const PROVIDER_LABELS: Record<number, string> = {
  1: "Custom IMAP/SMTP",
  2: "Google",
  3: "Microsoft",
  4: "AWS",
  8: "AirMail",
  11: "Airmail Instant",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return { days: Number(get("--days") ?? 7) };
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json();
}

async function listAccounts(): Promise<Map<string, number>> {
  const providerByEmail = new Map<string, number>();
  let startingAfter: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const page = await fetchJson(`${API_BASE}/accounts?${qs.toString()}`);
    const items = page?.items ?? [];
    for (const a of items) providerByEmail.set(a.email, a.provider_code ?? 0);
    if (!page?.next_starting_after || items.length < 100) break;
    startingAfter = page.next_starting_after;
  }
  return providerByEmail;
}

async function dailyAnalytics(emails: string[], startDate: string, endDate: string): Promise<any[]> {
  const all: any[] = [];
  for (let i = 0; i < emails.length; i += 200) {
    const batch = emails.slice(i, i + 200);
    const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
    for (const e of batch) qs.append("emails", e);
    const rows = await fetchJson(`${API_BASE}/accounts/analytics/daily?${qs.toString()}`);
    all.push(...(Array.isArray(rows) ? rows : []));
  }
  return all;
}

async function main() {
  const { days } = parseArgs();
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  console.error(`Fetching accounts...`);
  const providerByEmail = await listAccounts();
  const emails = [...providerByEmail.keys()];
  console.error(`${emails.length} accounts. Fetching daily analytics ${startDate} to ${endDate}...`);

  if (!emails.length) {
    console.log("No accounts found.");
    return;
  }

  const rows = await dailyAnalytics(emails, startDate, endDate);

  interface Agg { count: Set<string>; sent: number; replies: number; bounces: number }
  const byProvider = new Map<number, Agg>();
  for (const r of rows) {
    const provider = providerByEmail.get(r.email_account) ?? 0;
    if (!byProvider.has(provider)) byProvider.set(provider, { count: new Set(), sent: 0, replies: 0, bounces: 0 });
    const agg = byProvider.get(provider)!;
    agg.count.add(r.email_account);
    agg.sent += Number(r.sent ?? 0);
    agg.replies += Number(r.replies ?? 0);
    agg.bounces += Number(r.bounced ?? 0);
  }

  console.log(`\nInbox Type Comparison — last ${days} days\n`);
  console.log(`Type                Inboxes    Sent   Replies  Bounces   Reply %  Bounce %`);
  console.log(`------------------  -------  ------  --------  -------  --------  --------`);

  let totalInboxes = 0, totalSent = 0, totalReplies = 0, totalBounces = 0;
  const sorted = [...byProvider.entries()].sort((a, b) => b[1].sent - a[1].sent);
  for (const [provider, agg] of sorted) {
    const label = PROVIDER_LABELS[provider] ?? `Unknown (${provider})`;
    const replyPct = agg.sent ? ((agg.replies / agg.sent) * 100).toFixed(2) : "0.00";
    const bouncePct = agg.sent ? ((agg.bounces / agg.sent) * 100).toFixed(2) : "0.00";
    console.log(
      `${label.padEnd(18)}  ${String(agg.count.size).padStart(7)}  ${String(agg.sent).padStart(6)}  ${String(agg.replies).padStart(8)}  ${String(agg.bounces).padStart(7)}  ${replyPct.padStart(7)}%  ${bouncePct.padStart(7)}%`
    );
    totalInboxes += agg.count.size;
    totalSent += agg.sent;
    totalReplies += agg.replies;
    totalBounces += agg.bounces;
  }
  console.log(`------------------  -------  ------  --------  -------  --------  --------`);
  const totalReplyPct = totalSent ? ((totalReplies / totalSent) * 100).toFixed(2) : "0.00";
  const totalBouncePct = totalSent ? ((totalBounces / totalSent) * 100).toFixed(2) : "0.00";
  console.log(
    `${"TOTAL".padEnd(18)}  ${String(totalInboxes).padStart(7)}  ${String(totalSent).padStart(6)}  ${String(totalReplies).padStart(8)}  ${String(totalBounces).padStart(7)}  ${totalReplyPct.padStart(7)}%  ${totalBouncePct.padStart(7)}%`
  );

  console.log(`\nNote: reply rate here is RAW, not positive. Use /instantly-positive-reply-scoring for the metric that matters.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
