---
name: instantly-inbox-manager
description: Programmatic inbox management for Instantly. Alternative to /smartlead-inbox-manager for Instantly users. Enable/disable warmup, set signatures in bulk, tag accounts (active vs insurance), and pull account health dashboards. Use after creating a new batch of inboxes via /zapmail-domain-setup-public, or when managing an existing Instantly account at scale. Triggers on "turn on warmup", "set signatures", "tag inboxes", "inbox health", "set up new inboxes" when the user is on Instantly rather than Smartlead.
---

# Instantly Inbox Manager

Zapmail hands you hundreds of new inboxes. Instantly needs them configured: warmup enabled, signatures set, tags applied so you know which are active vs insurance, and health monitored so dead accounts get recycled.

This is the Instantly equivalent of `/smartlead-inbox-manager` — same operations, same active/insurance tagging convention, different API underneath. If you're on Smartlead, use that skill instead.

## Core operations

| Operation | What it does | Script |
|---|---|---|
| Enable warmup | Turns on warmup with limit/reply-rate/increment config | `set-warmup.ts --mode=enable` |
| Disable warmup | Turns off warmup (use for insurance-turned-active accounts) | `set-warmup.ts --mode=disable` |
| Set signatures | Bulk-applies a signature template to accounts | `set-signatures.ts` |
| Tag as active | Adds the "active" tag | `tag-inboxes.ts --add-tag=active` |
| Tag as insurance | Adds the "insurance" tag | `tag-inboxes.ts --add-tag=insurance` |
| Health dashboard | Lists all accounts with warmup status, reputation | `list-health.ts` |

## Active vs insurance (same convention as Smartlead)

- **Active accounts** — currently sending in live campaigns. Warmup OFF to prioritize real sends.
- **Insurance accounts** — warmed but idle, held in reserve. Warmup ON to maintain reputation. Swap in when an active account burns out.

## Inputs

Every script reads:
- `INSTANTLY_API_KEY` (env var)
- Account selector: `--emails=a@x.com,b@y.com` OR `--domain=example.com` OR `--tag=insurance` OR `--all` OR `--emails-from-csv=path`

**Important difference from Smartlead:** Instantly identifies accounts by **email address**, not a numeric ID. Where the Smartlead version uses `--ids=1,2,3`, this version uses `--emails=a@x.com,b@y.com`.

## Warmup configuration

Instantly's warmup config (`PATCH /accounts/{email}` with a `warmup` object) is genuinely different from Smartlead's, not just renamed fields:

```json
{
  "warmup": {
    "limit": 40,
    "reply_rate": 20,
    "increment": "2"
  }
}
```

- `limit` — max emails/day the account sends in the warmup network (like Smartlead's `total_warmup_per_day`)
- `reply_rate` — how often warmup peers reply, as a plain number (Smartlead uses a string; Instantly uses a number)
- `increment` — **a discrete level, not a literal per-day count.** Valid values: `"disabled"`, `"0"`, `"1"`, `"2"`, `"3"`, `"4"`. There is no documented mapping between "level 2" and an exact daily increment — Instantly controls the actual ramp curve internally. **Don't try to translate a specific Smartlead `--ramp=5` number 1:1 into an Instantly increment level** — pick a level and observe.

Default config for a NEW account (full ramp):
```
--warmup-limit=40 --reply-rate=20 --increment=2
```

For INSURANCE accounts (low-maintenance):
```
--warmup-limit=15 --reply-rate=20 --increment=disabled
```

For ACTIVE accounts (currently in live campaigns): just `--mode=disable` — no config fields needed.

## Signature template

Identical template and env vars to `/smartlead-inbox-manager`:

```
{from_name}
{title}
{company}
{address}
```

Required `.env` entries: `SENDER_FIRST_NAME`, `SENDER_LAST_NAME`, `SENDER_TITLE`, `SENDER_COMPANY_NAME`, `SENDER_PHYSICAL_ADDRESS`.

**One real difference:** Instantly's account schema has no per-account `from_name` override field the way Smartlead does. Every account gets the same `{from_name}` (from env), with no way to give individual accounts different personas via this field. If you need per-account personas on Instantly, that has to come from the account's own `first_name`/`last_name` fields set at account-creation time — this script doesn't manage that.

## Tags are workspace objects, not free-text strings

Instantly tags are created resources (`POST /custom-tags`), not arbitrary strings attached inline. This skill's scripts handle that automatically — `tag-inboxes.ts` looks up an existing tag by label, or creates it if it doesn't exist yet. No color support (Smartlead's `--add-tag=name:color` syntax has no Instantly equivalent — the CustomTag schema has no color field).

## Health dashboard field mapping

Instantly's account object doesn't have Smartlead's `is_smtp_success`/`is_imap_success`/`warmup_reputation` fields. The mapping used here:

| Smartlead concept | Instantly field |
|---|---|
| SMTP/IMAP connection ok | `status` (1 = Active; negative values = various error states) |
| Warmup blocked | `warmup_status` (-1 Banned, -3 Permanent Suspension) |
| Warmup reputation % | `stat_warmup_score` (0-100) |
| Daily sent count | **Not directly available** in the account list — would need `GET /accounts/analytics/daily` (not implemented in `list-health.ts`; extend if you need exact send volume) |

## Verification status

This skill's API calls were checked against Instantly's live OpenAPI spec and, where possible, probed against the live API directly (confirmed: account listing, tag create/search/dedup, the `custom-tags/toggle-resource` endpoint's email-based identifier format via a "not found" response for a fake email, the warmup enable endpoint's response shape, and the account PATCH endpoint's 404 behavior for a nonexistent email). **What's NOT verified:** a full successful round-trip against a real connected account — the workspace used to build this had zero connected email accounts. Test each script against one real account before running at scale.

## Common workflows

### Day 1 after Zapmail provisioning

```bash
npx tsx scripts/set-warmup.ts --mode=enable --tag=new --warmup-limit=40 --reply-rate=20 --increment=2
npx tsx scripts/set-signatures.ts --tag=new --template="Best,\n{from_name}"
npx tsx scripts/tag-inboxes.ts --tag=new --add-tag=insurance --remove-tag=new
```

### Activating insurance accounts into a live campaign

```bash
npx tsx scripts/list-health.ts --tag=insurance --filter=reputation:good --out=activate-candidates.csv
npx tsx scripts/tag-inboxes.ts --emails-from-csv=activate-candidates.csv --add-tag=active --remove-tag=insurance
npx tsx scripts/set-warmup.ts --mode=disable --tag=active
```

### Weekly health check

```bash
npx tsx scripts/list-health.ts --all --out=health-$(date +%Y-%m-%d).csv
```

## Common gotchas

- **Warmup ramp is a discrete level, not a number.** See "Warmup configuration" above — this is the single biggest interface difference from the Smartlead version.
- **Accounts are identified by email, not numeric ID.** `--emails=`, not `--ids=`.
- **Tags auto-create.** Tagging with a label that doesn't exist yet creates it — no separate "create tag first" step needed.
- **`increment` values are strings**, even though they look numeric (`"2"`, not `2`) — except `"disabled"`.
- **Warmup enable/disable returns a background job**, not an immediate result — the API applies it asynchronously. This script doesn't poll for job completion; check `list-health.ts` a few minutes later to confirm.

## What to do next

**If you just provisioned new accounts:** enable warmup, apply signatures, tag `insurance`, then **wait 2 weeks for warmup**. After 2 weeks, promote `insurance` → `active`.

**If accounts are already warm:** proceed to list-building using `active`-tagged accounts, then `/instantly-campaign-upload-public`.

**Or wait:** if health dashboard shows bad-reputation accounts, retire them first before launching a new campaign.

## Related skills

- `/zapmail-domain-setup-public` — creates the inboxes this skill configures
- `/instantly-campaign-upload-public` — required next step: upload a campaign using `active`-tagged accounts
- `/smartlead-inbox-manager` — the Smartlead equivalent; same operations, same tagging convention

## Scripts

- `scripts/set-warmup.ts` — enable/disable warmup, configure limit/reply-rate/increment
- `scripts/set-signatures.ts` — bulk signature setting
- `scripts/tag-inboxes.ts` — add/remove tags (auto-creates tags)
- `scripts/list-health.ts` — health dashboard CSV + summary
- `scripts/_lib.ts` — shared: API client, account selector parser, tag resolution, concurrency
