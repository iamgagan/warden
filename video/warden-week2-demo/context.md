# Product Context — Warden

## Product
- **Name:** Warden
- **URL:** https://github.com/iamgagan/warden (private repo)
- **One-liner:** Spend guardrails + audit receipts for AI agents that pay with virtual cards, built on the AgentCard MCP.
- **Tech stack:** TypeScript, Model Context Protocol (MCP), SQLite (drizzle), Hono API, React dashboard, AgentCard + Stripe Issuing as card rails.

## Audience
- **Who:** Ship Season 2026 program reviewers (technical + business hybrid) — this is a weekly progress-report video, not a cold outbound demo.
- **Pain points:** AI agents are starting to spend real money unsupervised; prompt injection is unsolved; Visa/Mastercard now require intent records for agentic payments and nothing on the agent side produces them.
- **Desired action:** No hard CTA — this is a status/progress update. The implicit ask is "follow the build."

## Brand
- **Colors:** Neutral, restrained — off-white background (#f5f5f4), near-black text (#1a1a1a), white cards with a 1px #e5e5e5 border and 10px radius. Two accent badges: indigo (#3730a3 on #eef2ff) for the AgentCard rail, green (#15803d on #f0fdf4) for the Stripe rail.
- **Typography:** System sans-serif (-apple-system stack); monospace (ui-monospace/SF Mono) for IDs, amounts-adjacent technical values.
- **Tone:** Plain and direct, zero marketing fluff — matches the product's own copy discipline (SPEC.md explicitly bans words like "unhackable"; approved framing is "guardrails," "receipts," "policy blocked an off-policy purchase").
- **Visual style:** Clean, minimal SaaS dashboard. Light theme.

## Video Concept
- **Type:** showcase
- **Angle:** The Hero Feature — deep dive on the policy editor (this week's shipped milestone) with the enforcement + receipt loop as proof, closing on a multi-rail teaser.
- **Duration:** 60 seconds
- **Theme:** light
- **Voice:** local TTS fallback (no ELEVENLABS_API_KEY set) — Kokoro-82M via `npx hyperframes tts`; ElevenLabs voice IDs below don't apply until a key is added.

## Features to Highlight
1. Policy editor (T11/T12) — human sets budget, allowed merchant, per-merchant cap; live immediately, no redeploy. This week's actual shipped milestone.
2. Deterministic enforcement — an off-policy purchase attempt (simulated prompt injection) is blocked before a card ever exists.
3. Intent-bound receipts — every approved charge is bound to the exact instruction that caused it, framed against the Visa/Mastercard record-retention requirement.
4. Multi-rail (teaser only) — the same policy and receipt schema working across AgentCard and Stripe Issuing, not just one card network.
