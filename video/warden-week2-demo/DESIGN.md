# Design Contract — Warden

Derived directly from Warden's real `apps/web/src/styles.css` (ground truth, not estimated
from pixels — the dashboard shown in every screenshot in this project uses these exact values).

## Design Contract

### Palette
- Background:  #f5f5f4 (warm off-white)
- Surface:     #ffffff (cards), border 1px #e5e5e5
- On-surface:  #1a1a1a (primary text), #777 (subtle/secondary text), #999 (labels/uppercase)
- Accent (rail — AgentCard): background #eef2ff, text #3730a3 (indigo)
- Accent (rail — Stripe):    background #f0fdf4, text #15803d (green)
- Mode badge (test):  background #e0ecff, text #1d4ed8
- Success/saved:      #15803d
- Error:              #b91c1c

### Typography
- Display / Headline: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif — the
  product wordmark ("Warden") is 26px, weight 700, letter-spacing -0.5px.
- Body: same stack, 13.5–15px for table/body content.
- Labels: 10.5–11px, weight 700, letter-spacing 0.8px, uppercase, color #999 (stat labels,
  table headers).
- Mono: ui-monospace, 'SF Mono', Menlo, monospace, ~0.85em — used for card IDs, policy IDs,
  timestamps. Use for every technical value shown on screen (card_id, receipt id, etc.) to
  match the real product exactly.

### Shape
- Radius: 10px (cards/panels), 6px (inputs/buttons), 999px (pills/badges).
- Border: 1px solid #e5e5e5 (cards), 2px solid #1a1a1a (table header rule).
- Shadow: none in the real product — Warden's UI is flat, not elevated. Do not add drop
  shadows to recreate screenshots; keep the flat aesthetic in every scene, including title
  cards and transitions.

### Motion Defaults
- Entrance ease: power3.out (matches the restrained, non-flashy product tone)
- Stagger: 0.12–0.18s (slightly slower than a typical SaaS promo — this is a progress-report
  video, not a marketing launch; avoid anything that reads as hype)
- Transition: crossfade 0.7s between every scene, no metallic swoosh, no 3D — flat crossfades
  only, consistent with the product's own flat, unshadowed UI

## Per-Scene-Type Application

- **Screenshot scenes** (1, 2, 3, 5, 6): real PNG wrapped in a plain macOS-style browser
  chrome (thin #e5e5e5 border, no drop shadow — matches "Shape: no shadow" above), Ken-Burns
  drift only, never a hard cut.
- **Terminal scene** (4): macOS-style terminal window, monospace, dark terminal background
  (the one intentional dark surface in the piece — real terminals are dark, this isn't a
  brand deviation) with the product's indigo/green accent colors used sparingly for
  highlighting the block line (red-tinted, #b91c1c-adjacent) vs. settled lines (green,
  #15803d-adjacent) — echoes the dashboard's own status-color language.
- **Close scene** (7): pure wordmark on #f5f5f4, no chrome, matches the dashboard header
  treatment exactly (26px/700/-0.5px letter-spacing "Warden" + the tagline "every dollar,
  with the why" at 13px #888).

## Anti-patterns (this brand specifically)

- No gradients, no glassmorphism, no glow/neon accents — the real product has none.
- No drop shadows on cards (the real product is flat/bordered, not elevated).
- No marketing superlatives in on-screen text or narration ("unhackable," "revolutionary,"
  etc.) — SPEC.md explicitly bans this language in the product itself; the video should hold
  the same discipline.
