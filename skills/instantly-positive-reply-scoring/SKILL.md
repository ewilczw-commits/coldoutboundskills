---
name: instantly-positive-reply-scoring
description: Pulls replies from an Instantly campaign, classifies each as positive/neutral/negative/OOO/bounce/unsubscribe using Claude, and reports the positive reply rate — the north-star metric for cold email. Alternative to /positive-reply-scoring for Instantly users — identical classification schema and scoring math. Triggers on "score my replies", "how's campaign X doing", "positive reply rate", "is this campaign working" when the user is on Instantly rather than Smartlead.
---

# Instantly Positive Reply Scoring

**Reply rate tells you if people are paying attention. Positive reply rate tells you if they want what you're selling.** This skill computes the second.

This is the Instantly equivalent of `/positive-reply-scoring` — identical classification schema, identical scoring formulas and benchmarks. Only the data-fetching layer differs. If you're on Smartlead, use that skill instead.

## Why this exists

Same as the Smartlead version:
```
positive_reply_rate = positive_replies / total_sent
```

See `/positive-reply-scoring`'s SKILL.md for the full rationale — it's identical here.

## Classification schema

Identical to `/positive-reply-scoring` — same 11 labels (`positive_interested`, `positive_soft`, `positive_referral`, `neutral_question`, `negative_notnow`, `negative_notfit`, `negative_hostile`, `unsubscribe`, `ooo`, `bounce`, `other`), same positive-bucket definition, same exclusions.

## Why this fetch is simpler than Smartlead's

Smartlead requires listing leads with a reply flag, then fetching per-lead message history — an N+1 pattern. Instantly's `GET /emails` endpoint filters directly:

```
GET /emails?campaign_id=<uuid>&email_type=received
```

This returns every inbound reply for the campaign in one paginated call, body text included — no per-lead follow-up requests needed.

## Inputs

- Instantly API key (env: `INSTANTLY_API_KEY`)
- Campaign ID (UUID) to score
- Optional: `--since=YYYY-MM-DD` date filter

## Steps

### 1. Fetch all replies from the campaign

```bash
npx tsx scripts/fetch-campaign-replies.ts --campaign-id=<uuid> --out=/tmp/replies.json
```

**Note:** Instantly's email object doesn't carry `lead_first_name`, `company`, or `sequence_step` the way Smartlead's does — those fields come back empty in the output JSON. If your classification prompt needs that context, join against your `leads.csv` by `lead_id`/email first, or fetch `GET /leads/{id}` per reply.

**Rate limit:** `GET /emails` is capped at 20 requests/minute (lower than most Instantly endpoints) — the script paces itself accordingly, so large campaigns take longer to fetch than you might expect from other Instantly scripts in this repo.

### 2. Classify replies in the Claude Code conversation

Identical process to `/positive-reply-scoring` step 2 — same classification prompt, same fan-out pattern via `/personalization-subagent-pattern`.

**Deliberately not used:** Instantly has its own reply metadata (`i_status` / `lt_interest_status` enum: `0`=Out of Office, `1`=Interested, `2`=Meeting Booked, `3`=Meeting Completed, `4`=Won, `-1`=Not Interested, `-2`=Wrong Person, `-3`=Lost, `-4`=No Show) and even a built-in AI label predictor (`POST /lead-labels/test-prediction`). This skill uses Claude directly instead, for the same reason the Smartlead version does: transparency and a prompt you can tune, rather than a black-box categorizer.

### 3. Aggregate + compute rates

```bash
npx tsx scripts/aggregate-scores.ts --replies=/tmp/classified-replies.json --campaign-id=<uuid>
```

Same output format as the Smartlead version, plus one extra line: `instantly_auto_detected_replies` — Instantly's own automatic-reply count (`reply_count_automatic` from `GET /campaigns/analytics`), surfaced as a cross-check only. It is not used in the scoring math above it; a big gap between this number and your own `ooo` bucket count is worth a second look.

### 4-5. Save to disk, flag action items

Identical to `/positive-reply-scoring`.

## Verification status

Both scripts were run against the live Instantly API before shipping — `fetch-campaign-replies.ts` confirmed the `GET /emails` filter params are accepted (tested against a nonexistent campaign, which correctly returns 0 results rather than an error), and `aggregate-scores.ts` confirmed `GET /campaigns/analytics?id=` returns the expected array shape with `emails_sent_count`. Not tested against a campaign with real reply volume, since no such campaign existed in the workspace used to build this.

## Common gotchas

Same as `/positive-reply-scoring`, plus:
- **`GET /campaigns/analytics` returns an array**, even when queried with a single `id` — the script takes the first element. Don't call it expecting a bare object.
- **Missing lead context on the email object.** See the note under Step 1 — you may need a join step your Smartlead workflow didn't require.

## What to do next

Identical to `/positive-reply-scoring` — respond to positive replies fast, then `/experiment-design` for the next iteration.

## Related skills

- `/positive-reply-scoring` — the Smartlead equivalent; identical classification schema
- `/experiment-design` — uses positive reply rate as the success metric
- `/instantly-campaign-upload-public` — the campaign this skill scores was likely uploaded via this

## Scripts

- `scripts/fetch-campaign-replies.ts` — pulls replies via `GET /emails`
- `scripts/aggregate-scores.ts` — computes rates from classified JSON + `GET /campaigns/analytics`
