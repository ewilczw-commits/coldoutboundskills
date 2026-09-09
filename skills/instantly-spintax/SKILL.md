---
name: instantly-spintax
description: Adds Instantly-compatible spintax to cold email sequences for deliverability. Alternative to /smartlead-spintax for Instantly users — the syntax is genuinely different, not just relabeled. Use this skill whenever the user asks to add spintax, spin text, add variations, or improve deliverability of email copy for an Instantly campaign. Also trigger on "spintax", "spin", "variations" when Instantly is the sending platform. Works with both plain text and HTML input.
---

# Instantly Spintax Skill

Add deliverability-improving spintax to cold email sequences using **Instantly's syntax**, without changing the meaning or tone of the original messaging.

**This is not just a renamed copy of `/smartlead-spintax`.** Instantly's spintax format is genuinely different — copy-pasting Smartlead-formatted spintax into an Instantly campaign will not expand correctly. Verified against Instantly's own help documentation before writing this skill.

## Core Concept

Spintax lets Instantly randomly pick one option per send, so no two emails are identical. This reduces pattern detection by spam filters and improves deliverability.

**Instantly syntax:** `{{RANDOM | option1 | option2 | option3}}`

Compare to Smartlead's `{option1|option2|option3}` — three real differences:
1. **Double curly braces** `{{ }}`, not single `{ }` (matches Instantly's own merge-variable convention)
2. **The literal keyword `RANDOM`** immediately after the opening braces, followed by a pipe
3. **Spaces around each pipe** are used consistently in Instantly's own examples (` | `, not `|`)

Instantly's own docs confirm merge variables can nest inside a spintax block:
```
{{RANDOM | Quick question, {{companyName}} | Quick question {{firstName}}}}
```

---

## Input Handling

### HTML Input (preferred workflow)

Users often paste HTML from Instantly's campaign editor. When the user provides HTML:

1. Mentally parse the text content from the HTML
2. Add spintax to the text content using Instantly's `{{RANDOM | ... | ...}}` format
3. Return the full HTML with spintax baked in, preserving all HTML tags, `<br>`, `<div>`, structure exactly as received
4. Output as a code block so the user can copy-paste straight back into Instantly

### Plain Text Input

If the user pastes plain text, add spintax and return plain text.

---

## The Golden Rule: No Broken Combinations

Identical principle to `/smartlead-spintax` — every possible combination Instantly could randomly assemble MUST read as a natural, grammatically correct, complete sentence.

**BAD — dependent blocks that can break:**
```
{{RANDOM | let me know if | would}} {{employeeLine}} {{RANDOM | would be better to speak to | be a better person to chat with}}
```
Problem: "would" + "would be better to speak to" = broken.

**GOOD — each option is a full standalone phrase:**
```
{{RANDOM | let me know if {{employeeLine}} would be better to speak to about this? | would {{employeeLine}} be a better person to chat with about this? | should I be reaching out to {{employeeLine}} about this instead?}}
```

### Verification step

After adding spintax, mentally walk through every combination across adjacent blocks. If any pairing sounds off, restructure so each block is independent, or wrap the entire sentence in one spintax block with full sentence alternatives.

---

## What to Spin

Same targets as `/smartlead-spintax` — 2-3 options per block:

### Always spin
- **Greetings:** `{{RANDOM | Hey | Hi}}`
- **Opt-out / unsubscribe lines**
- **CTAs**
- **Transition words:** "just", "also", "actually"

### Spin when natural
- **Verb choices:** `{{RANDOM | help | work with}}`, `{{RANDOM | built | made}}`
- **Descriptors:** `{{RANDOM | completely free | on us | 100% free}}`
- **Sentence-level rephrasings**

### Never spin
- **Instantly merge variables:** `{{firstName}}`, `{{companyName}}`, `{{lastName}}` — leave exactly as-is (note Instantly's camelCase convention, different from Smartlead's snake_case `{{first_name}}`)
- **Specific data points:** numbers, stats, brand names, pricing
- **Technical terms** that need to be precise

---

## Tone Preservation

Identical principle to `/smartlead-spintax` — options must match the original's register. Casual stays casual; direct stays direct.

---

## Output Format

### For HTML input

```html
{{RANDOM | Hey | Hi}} {{firstName}}, {{RANDOM | open to a free backlink on | interested in a free backlink from}} Forbes, WSJ, or Tech Times for {{companyName}}?
<br>
<br>{{RANDOM | We work with | We partner with}} a network of over 1,200 publishers...
```

### For plain text input

```
{{RANDOM | Hey | Hi}} {{firstName}}, {{RANDOM | open to a free backlink on | interested in a free backlink from}} Forbes, WSJ, or Tech Times for {{companyName}}?
```

### After each email

State: "All combos clean." If you found and fixed something, note what you changed and why. Then ask: "Next?" to keep the flow moving.

---

## Multi-Email Sequences

Same process as `/smartlead-spintax` — one email at a time, confirm combos clean, prompt for the next.

---

## Flagging Issues

Same as `/smartlead-spintax` — flag awkward original copy briefly, minimally, only when it would actually hurt performance.

---

## Quick Reference

| Element | Instantly | Smartlead (for comparison) |
|---|---|---|
| Syntax | `{{RANDOM \| option1 \| option2}}` | `{option1\|option2}` |
| Greeting | `{{RANDOM \| Hey \| Hi}}` | `{Hey\|Hi}` |
| Verb swap | `{{RANDOM \| help \| work with \| partner with}}` | `{help\|work with\|partner with}` |
| Merge variable style | `{{firstName}}` (camelCase) | `{{first_name}}` (snake_case) |
| Never touch | `{{firstName}}`, `{{companyName}}` | `{{first_name}}`, `{{company_name}}`, `%signature%` |

---

## What to do next

**Launch the spintaxed copy** via `/instantly-campaign-upload-public` — the spintax gets embedded in the `variants.yaml` body fields and Instantly expands it per-recipient on send.

**If the user pastes Smartlead-formatted spintax and says they're on Instantly:** convert it — swap `{opt1|opt2}` → `{{RANDOM | opt1 | opt2}}` and `{{snake_case}}` variables → the Instantly equivalent camelCase names, don't just relabel it.

**Or wait:** skip this skill until copy is final. Spintax complicates later debugging.

## Related skills

- `/smartlead-spintax` — the Smartlead equivalent (different syntax — don't mix them up)
- `/campaign-copywriting` — writes the base copy this skill varies
- `/instantly-campaign-upload-public` — launches the spintaxed campaign
