---
name: instantly-deliverability-audit
description: Diagnostic audit for a running Instantly cold email program. Checks domain authentication (SPF/DKIM/DMARC, shared with /email-deliverability-audit), account health/reputation, sent/reply/bounce rate per campaign, and optionally runs a spam placement test via Instantly's Inbox Placement Testing API. Alternative to /email-deliverability-audit for Instantly users. Use when reply rates drop, when bounces spike, when onboarding someone else's account, or as a weekly/monthly health check.
---

# Instantly Deliverability Audit

**If your positive reply rate is dropping and you don't know why, start here.** This is the Instantly equivalent of `/email-deliverability-audit` — same 1% rule, same audit structure, different API underneath. If you're on Smartlead, use that skill instead.

## What it checks

| Layer | What | How |
|---|---|---|
| DNS auth | SPF, DKIM, DMARC present on each sending domain | `dig` — **shared with `/email-deliverability-audit`**, no Instantly-specific version needed |
| Account health | Warmup status, reputation, connection failures | Instantly accounts API |
| Send + reply + bounce rate per campaign | `emails_sent_count`, `reply_count`, `bounced_count` | Instantly campaign analytics |
| Spam placement | Real inbox-vs-spam test via Instantly Inbox Placement Testing | optional |

## The 1% rule

Identical to `/email-deliverability-audit` — a healthy campaign should have ≥1% reply rate after 200+ sends. See that skill's SKILL.md for the full rationale; it's platform-agnostic.

## Inputs

- `INSTANTLY_API_KEY` (env)
- Optional: `--campaign-ids=<uuid1>,<uuid2>` to scope the audit
- Optional: `--tag=active` / `--domain=example.com` for account-level scripts

## Steps

### 1. Pull the account inventory

```bash
npx tsx scripts/audit-inboxes.ts --all --out=/tmp/audit/inboxes.csv
```

Outputs per account: email, domain, tags, status, warmup_status, warmup_score, warmup_limit, daily_limit, provider_code.

### 2. Check domain authentication

**No Instantly-specific script needed** — `check-domain-auth.ts` from `/email-deliverability-audit` is pure DNS lookups (`dig`), with no platform API involved. Use it directly:

```bash
npx tsx ../email-deliverability-audit/scripts/check-domain-auth.ts --from-csv=/tmp/audit/inboxes.csv --out=/tmp/audit/auth.csv
```

(DKIM selector may differ if you're not on Zapmail's `default._domainkey` convention — see that script's `--dkim-selector` flag.)

### 3. Pull sent + reply + bounce metrics per campaign

```bash
npx tsx scripts/audit-performance.ts --out=/tmp/audit/performance
```

**Simpler than the Smartlead version:** Instantly's `GET /campaigns/analytics` accepts a batch of campaign ids and returns `emails_sent_count`/`reply_count`/`bounced_count` per campaign in one call — no per-campaign round trip needed.

**One thing dropped vs. Smartlead:** the "best-effort per-inbox aggregation" CSV. Instantly's API doesn't expose an equivalent per-inbox-per-campaign breakdown; `GET /accounts/analytics/daily` gives per-account volume but not scoped to a single campaign. Campaign-level is the authoritative signal anyway — extend this script against the daily-analytics endpoint yourself if you need per-inbox detail.

### 4. (Optional) Run an Inbox Placement Test

```bash
npx tsx scripts/run-spam-test.ts --campaign-id=<uuid> --subject="Quick question" \
  --body="Test body content" --senders=a@x.com,b@y.com --out=/tmp/audit/spam-test.json
```

This creates a real inbox-placement test via Instantly's API — genuinely simpler than Smartlead's Smart Delivery flow (one consolidated stats call instead of 7 separate report endpoints):

- Fetches available seed inbox types (`GET /inbox-placement-tests/email-service-provider-options`) and tests against all of them
- Sends from your specified sender accounts to Instantly-generated seed inboxes
- Polls for completion, then pulls inbox/spam/category (e.g. Promotions tab) percentages in one call

**Required fields were reverse-engineered by testing the live API**, not fully documented up front — see the script's header comment for the exact discovery path (iterating through "missing required property" errors). Confirmed live: a real test was created (with an intentionally fake, unconnected sender email so nothing was actually sent) and its response schema verified, then immediately deleted. **Not verified:** the full poll-to-completion and results flow — that needs a real connected sending account and real wall-clock time, which the build workspace didn't have.

### 5. Synthesize + act

No `generate-report.ts` equivalent exists here (the Smartlead skill references one in its own docs, but it isn't actually present in this repo either — this isn't an Instantly-specific gap). Read the CSVs directly, or write a synthesis step yourself following the report format in `/email-deliverability-audit`'s SKILL.md.

Feed action items into:
- Missing DKIM/SPF → `/zapmail-domain-setup-public`
- Blocked/bad-reputation accounts → `/instantly-inbox-manager` to tag "retired" and rotate in insurance
- Bad copy flagged → `/spam-word-checker`

## Interpreting the numbers

Identical thresholds to `/email-deliverability-audit` for bounce rates, spam placement, and DMARC policy stages. One difference: Instantly's warmup reputation field is `stat_warmup_score` (0-100, same scale as Smartlead's `warmup_reputation`) rather than a differently-named field — the interpretation bands (>80 good, 50-80 keep warming, <50 don't send) carry over directly.

## Common gotchas

- **`GET /campaigns/analytics` returns an array even for one id** — batch it, don't assume a bare object.
- **Inbox placement test required fields aren't all in the top-level docs** — `emails` (senders), `delivery_mode`, and `email_subject`/`email_body` are all required even when `sending_method: 1` (From Instantly) and a `campaign_id` are provided. See the script for the full verified field list.
- **No per-inbox breakdown in performance audit** — see Step 3's note.

## What to do next

**If any flag fired:** see `/deliverability-incident-response` (branches by platform where the underlying script/endpoint differs).

**If all clean:** run again next Monday, same cadence as the Smartlead version.

## Related skills

- `/email-deliverability-audit` — the Smartlead equivalent; shares `check-domain-auth.ts` with this skill
- `/instantly-inbox-manager` — execute the action items (rotate, retag, warmup settings)
- `/zapmail-domain-setup-public` — fix DNS/auth issues at the domain provider
- `/spam-word-checker` — check copy for spam-triggering phrases

## Scripts

- `scripts/audit-inboxes.ts` — pull + format account inventory
- `scripts/audit-performance.ts` — per-campaign sent/replies/bounces/rates (applies the 1% rule)
- `scripts/run-spam-test.ts` — create + poll + pull an Inbox Placement Test
- Domain auth: use `/email-deliverability-audit/scripts/check-domain-auth.ts` directly — no separate copy here
