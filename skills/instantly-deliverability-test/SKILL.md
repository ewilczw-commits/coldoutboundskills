---
name: instantly-deliverability-test
description: Compare reply rates, bounce rates, and positive reply rates broken down by inbox provider type (Google / Microsoft / Custom IMAP-SMTP / AirMail) for an Instantly workspace. Alternative to /deliverability-test-public for Instantly users. Use when you want to know "which inbox type delivers best" or when debugging unexplained deliverability differences across a mixed fleet. Operates via Instantly API only.
---

# Instantly Deliverability Test — Inbox Type Comparison

Compare reply rates, bounce rates, and positive reply rates broken down by inbox provider type across your Instantly workspace. This is the Instantly equivalent of `/deliverability-test-public` — same purpose, same output shape, different grouping field and data source underneath. If you're on Smartlead, use that skill instead.

## Why this exists

Same rationale as `/deliverability-test-public` — different inbox providers have different deliverability characteristics. Instantly groups accounts by `provider_code` rather than Smartlead's `type` field:

| provider_code | Label |
|---|---|
| 1 | Custom IMAP/SMTP |
| 2 | Google |
| 3 | Microsoft |
| 4 | AWS |
| 8 | AirMail |
| 11 | Airmail Instant |

## A better data source than the Smartlead version

The Smartlead version joins per-campaign analytics against inbox lists to approximate per-inbox performance. This version uses `GET /accounts/analytics/daily` instead, which gives **per-account** sent/replies/bounced counts directly — verified live. That's arguably more accurate: it's fleet-wide by construction, not scoped to "campaigns that happen to use these inboxes."

## What you need

- `INSTANTLY_API_KEY` in env
- Optional: `--days=<N>` lookback (default 7, capped at 31 by the underlying endpoint)

## Steps

```bash
# Full workspace, last 7 days
npx tsx scripts/inbox-type-compare.ts

# 14-day lookback
npx tsx scripts/inbox-type-compare.ts --days=14
```

## Output

Same shape as the Smartlead version:

```
Inbox Type Comparison — last 7 days

Type                Inboxes    Sent   Replies  Bounces   Reply %  Bounce %
------------------  -------  ------  --------  -------  --------  --------
Google                   12    3120        42        12      1.35%     0.38%
Microsoft                24    6440        65        28      1.01%     0.43%
Custom IMAP/SMTP         44   10780        55        98      0.51%     0.91%
------------------  -------  ------  --------  -------  --------  --------
TOTAL                    80   20340       162       138      0.80%     0.68%
```

## How it works

1. Lists all accounts (`GET /accounts`, paginated) to build an email → `provider_code` map
2. Fetches `GET /accounts/analytics/daily` for the lookback window, batched at 200 emails/call (the endpoint's max) — verified live to return a bare array of `{date, email_account, sent, replies, bounced, ...}` rows
3. Aggregates sent/replies/bounced per provider group
4. Prints the comparison table

## Common gotchas

- **Reply rate here is RAW, not positive.** Use `/instantly-positive-reply-scoring` for the metric that matters.
- **Small inbox counts are noisy** — same caveat as the Smartlead version.
- **`GET /accounts/analytics/daily` caps at a 31-day range and 200 emails per call.** This script batches the email list but does not chunk a >31-day date range — pass `--days=31` max.

## What to do next

**If one inbox type is underperforming:** `/instantly-inbox-manager` to retire the bad ones. If replacements are needed, `/zapmail-domain-setup-public` for new domains on a different provider type.

**If all types are healthy:** back to the weekly rhythm.

**Or wait:** small sample sizes (<500 sends per type) are noisy — re-run in 7 days with more data.

## Related skills

- `/deliverability-test-public` — the Smartlead equivalent
- `/instantly-deliverability-audit` — full audit (SPF/DKIM/DMARC + reputation + spam placement)
- `/instantly-positive-reply-scoring` — the metric that matters, not just reply rate
- `/instantly-inbox-manager` — rotate out bad inboxes, tag by performance

## Scripts

- `scripts/inbox-type-compare.ts` — pulls + compares per-provider-type rates
