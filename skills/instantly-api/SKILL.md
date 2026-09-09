---
name: instantly-api
description: Instantly API v2 endpoint reference and patterns. Alternative to /smartlead-api for Instantly users. Use for any Instantly campaign, lead, account, analytics, or inbox operation. Covers auth, pagination, and all endpoints used by this repo's instantly-* skills.
user_invocable: false
---

# Instantly API Reference

Every fact below was checked against Instantly's live OpenAPI spec (`https://developer.instantly.ai/api-reference/openapi.json`) during this repo's Instantly integration work, and most were also confirmed against the live API directly (create/delete round-trips, error-shape probing). Endpoints marked "not live-tested" were checked against the spec only.

## Authentication

Bearer token: `Authorization: Bearer {INSTANTLY_API_KEY}` header on every request — NOT a query parameter (unlike Smartlead's `?api_key=`).

Environment variable: `$INSTANTLY_API_KEY`

Base URL: `https://api.instantly.ai/api/v2`

## Rate Limiting

No single published blanket rate limit was found in the OpenAPI spec (every endpoint documents a generic 429 response, but not a specific req/min ceiling). Known per-endpoint exception: `GET /emails` (unibox) is capped at **20 requests/minute** — much lower than you'd assume by analogy with other endpoints. Retry on 429 with exponential backoff, same as any well-behaved client. If you find a documented blanket limit, add it here.

## Pagination

Cursor-based, not offset-based (different from Smartlead's `offset`/`limit`):

```
GET /accounts?limit=100&starting_after=<cursor>
```

Response: `{ items: [...], next_starting_after: "<cursor>" }`. Loop until `next_starting_after` is absent or `items.length < limit`.

## API Endpoints

### Accounts (inboxes)

Identified by **email address**, not a numeric ID — every account endpoint takes the email in the path.

```
GET    /accounts?include_tags=true         — List accounts (paginated)
GET    /accounts/{email}                   — Get one account
PATCH  /accounts/{email}                   — Update (signature, warmup config, daily_limit, ...)
DELETE /accounts/{email}                   — Delete account

POST   /accounts/warmup/enable             — Bulk enable warmup: { emails: [...] } or { include_all_emails: true, filter: {...} }
POST   /accounts/warmup/disable            — Bulk disable warmup (same body shape)
GET    /accounts/warmup/analytics          — Warmup analytics
GET    /accounts/analytics/daily           — Per-account daily sent/replies/bounced/opens/clicks
                                              (start_date, end_date — max 31-day range; emails — max 200/call)
POST   /accounts/test-vitals               — Test account vitals (no Smartlead equivalent)
```

**PATCH body for warmup config** (verified live — 404s correctly on a nonexistent email, confirming the shape reaches real validation):
```json
{ "warmup": { "limit": 40, "reply_rate": 20, "increment": "2" } }
```
`increment` is a **discrete level string** (`"disabled"`, `"0"`-`"4"`), not a literal per-day count — there's no documented mapping to an exact ramp curve.

**Account status enums:**
```
status:        -3 Sending Error, -2 Soft Bounce, -1 Connection Error, 1 Active, 2 Paused, 3 Maintenance
warmup_status: -3 Permanent Suspension, -2 Spam Folder Unknown, -1 Banned, 0 Paused, 1 Active
```

### Campaigns

```
GET    /campaigns?limit=100&starting_after=<cursor>  — List
POST   /campaigns                                     — Create (status 0 = Draft by default — no separate "activate at creation" flag)
GET    /campaigns/{id}                                — Get
PATCH  /campaigns/{id}                                — Update
DELETE /campaigns/{id}                                — Delete
POST   /campaigns/{id}/activate                       — Start/resume
POST   /campaigns/{id}/stop                            — Pause
GET    /campaigns/analytics?id=<uuid>&ids=<uuid>&...  — Batch analytics (accepts MULTIPLE ids in one call — verified live)
```

**Create body** — schedule, sequences (steps), and sender accounts are all embedded in ONE call (unlike Smartlead's separate `/sequences` + `/email-accounts` + `/schedule` calls):

```json
{
  "name": "Campaign name",
  "campaign_schedule": {
    "schedules": [{
      "name": "default",
      "timing": { "from": "08:00", "to": "17:00" },
      "days": { "1": true, "2": true, "3": true, "4": true, "5": true },
      "timezone": "America/Detroit"
    }]
  },
  "sequences": [{
    "steps": [{
      "type": "email",
      "delay": 0,
      "delay_unit": "days",
      "variants": [{ "subject": "...", "body": "<div>...</div>" }]
    }]
  }],
  "email_list": ["sender1@x.com", "sender2@y.com"],
  "daily_max_leads": 30,
  "email_gap": 10,
  "stop_on_reply": true,
  "open_tracking": false,
  "link_tracking": false
}
```

**Two real quirks, both verified live (not guessed from docs):**

1. **Timezone is a ~102-value enum, not full IANA.** Common names are rejected. Working substitutes found by testing the full enum:
   `America/New_York` → `America/Detroit`, `America/Denver` → `America/Boise`, `America/Phoenix` → `America/Creston`, `America/Chicago` → unchanged. **No Pacific-time equivalent exists at all** — confirmed by testing `America/Los_Angeles`, `America/Vancouver`, `America/Tijuana`, all rejected.
2. **A bare `<br/>` mixed with unwrapped text in a `body` field gets silently stripped** — `"Hello there<br/>Second line"` comes back as `"<br />"`, with the actual words gone. Wrap multi-line bodies in `<div>...</div>` (verified: content survives correctly inside a block element).

**`days` object:** keys are `"0"`(Sunday) through `"6"`(Saturday) as booleans — different from Smartlead's `1`(Mon)-`7`(Sun) array.

**Campaign status enum:** `0` Draft, `1` Active, `2` Paused, `3` Completed, `4` Running Subsequences, `-99`/`-1`/`-2` various error/suspension states.

**Campaign analytics response fields** (per campaign, when batching `ids`): `campaign_id`, `campaign_name`, `campaign_status`, `emails_sent_count`, `reply_count`, `reply_count_automatic`, `bounced_count`, `open_count`, `link_click_count`, `unsubscribed_count`, `total_opportunities`, and more.

### Leads

```
POST   /leads                — Create ONE lead
POST   /leads/add             — Bulk add (1-1000 leads), body: { campaign_id | list_id, leads: [...] }
                                 NOTE: NOT "/leads/bulk-add" — that path 404s despite some doc indexes implying it.
GET    /leads/{id}            — Get
PATCH  /leads/{id}            — Update
DELETE /leads/{id}            — Delete
POST   /leads/update-interest-status  — { lead_email, interest_value, campaign_id? }
```

**Lead fields:** `email`, `first_name`, `last_name`, `company_name`, `job_title`, `phone`, `website`, `personalization`, `custom_variables` (arbitrary object — this is where non-standard merge fields go), `lt_interest_status`.

**`lt_interest_status` enum** (verified from the raw OpenAPI spec — not in the prose docs):
```
 4 Won              0 Out of Office     -1 Not Interested
 3 Meeting Completed                    -2 Wrong Person
 2 Meeting Booked                       -3 Lost
 1 Interested                           -4 No Show
```

**Bulk add response** includes `leads_uploaded`, `duplicated_leads`, `skipped_count`, `invalid_email_count`, `created_leads[]` — verified live.

### Emails (Unibox)

```
GET /emails?campaign_id=<uuid>&email_type=received&limit=100&starting_after=<cursor>
```

Returns inbound/outbound messages directly, body included — no per-lead follow-up call needed (unlike Smartlead's list-leads-then-fetch-message-history pattern). Key filters: `campaign_id`, `email_type` (`"received"`/`"sent"`/`"manual"`), `lead` (email), `is_unread`, `min_timestamp_created`/`max_timestamp_created`.

**Rate limit: 20 req/min** — the lowest of any endpoint in this reference. Pace scripts accordingly.

**Response fields per email:** `id`, `subject`, `from_address_email`, `to_address_email_list`, `body: {text, html}`, `lead`, `lead_id`, `campaign_id`, `ue_type` (1=sent from campaign, 2=received, 3=sent, 4=scheduled), `i_status` (same enum as `lt_interest_status`), `is_unread`.

### Custom Tags

Tags are workspace-level objects, not free-text strings (different from Smartlead's inline `{name, color}` tag objects).

```
GET    /custom-tags?search=<label>          — List/search (also filters existing tags by name)
POST   /custom-tags                          — Create: { label, description? } — no color field
DELETE /custom-tags/{id}                     — Delete
POST   /custom-tags/toggle-resource          — Assign/unassign: { tag_ids: [...], resource_type: 1|2|3, resource_ids: [...], assign: bool }
                                                 resource_type: 1=Account, 2=Campaign, 3=Workspace
```

**`resource_ids` format for accounts (resource_type=1) is email address strings** — not explicitly documented, but confirmed by probing the endpoint with a fake email and getting `{"statusCode":404,"message":"1 account(s) not found"}` (a not-found error, not a format-validation error).

### Inbox Placement Testing (Smart Delivery equivalent)

```
GET  /inbox-placement-tests/email-service-provider-options   — Available seed inbox types (varies by plan)
POST /inbox-placement-tests                                   — Create a test
GET  /inbox-placement-tests/{id}                               — Poll status
DELETE /inbox-placement-tests/{id}                             — Delete
POST /inbox-placement-analytics/stats-by-test-id               — { test_ids: [...] } → inbox/spam/category %
```

**Required create-body fields, discovered by iterating live "missing required property" errors** (not all stated up front in the docs): `name`, `type` (1=one-time, 2=automated), `sending_method` (1=From Instantly, 2=From Outside Instantly), `delivery_mode` (1=one-by-one, 2=all-together), `campaign_id`, `email_subject`, `email_body`, `emails` (sender accounts — plural, required even with a `campaign_id`), `recipients_labels` (array of `{region, sub_region, type, esp}`, sourced from the ESP-options endpoint).

Response includes a `recipients` array — the real seed inbox addresses Instantly generated for the test.

**Verified live:** a real test was created (id confirmed, full response schema captured) using a deliberately fake/unconnected sender email so nothing was actually sent, then immediately deleted. **Not verified:** the poll-to-completion and stats-fetch flow, since that needs a real connected account and real wall-clock time.

Consolidated stats response (much simpler than Smartlead's 7 separate report endpoints): `{ test_id, count, spam_count, spam_percent, inbox_count, inbox_percent, category_count, category_percent }` per test.

## TypeScript Pattern

```typescript
const API = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;

// GET example
const res = await fetch(`${API}/campaigns/${id}`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const campaign = await res.json();

// POST example (bulk add leads)
const res = await fetch(`${API}/leads/add`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({ campaign_id: campaignId, leads: leads.slice(0, 100) }),
});
```

## Performance tip: cache the accounts list

Same advice as `/smartlead-api` — if you hit `GET /accounts` more than a few times per script, paginate once at the start and keep the result in memory.

## What to do next

This is a reference skill — no direct next step. Used by every `instantly-*` skill in this repo (`instantly-inbox-manager`, `instantly-campaign-upload-public`, `instantly-deliverability-audit`, `instantly-deliverability-test`, `instantly-positive-reply-scoring`).

Return to the skill that sent you here.

## Related skills

- `/smartlead-api` — the Smartlead equivalent
- Every `instantly-*` skill in this repo uses this reference.
