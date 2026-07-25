# Storyboard — warden-week2-demo

**Duration:** 60s | **Canvas:** 1920×1080 (16:9) | **Renderer:** HyperFrames
**Mode:** showcase | **Theme:** light

All times are in seconds. Capture tooling note: no chrome-devtools MCP screencast and no
asciinema/agg available in this environment, so every web scene degrades to a real still
screenshot (captured via the claude-in-chrome browser tools against the actual running
dashboard) and the terminal scene is an **authored** scene built from real `demo-agent.js`
stdout, per the skill's own graceful-degradation rules (workflows/phase-2-capture.md).
Nothing here is a mockup — every visual is sourced from the real product.

Transitions: fade, 0.7s (medium), throughout — matches the product's own restrained,
no-marketing-fluff tone (SPEC.md bans overclaiming language; keep the video the same way).

---

### Scene 1: HOOK

**Window:** 0s → 6s (6s)
**Scene file:** `scenes/00-hook.html`
**Screenshot:** `public/screenshots/scene-00-policy-empty.png`
**Capture:** screenshot

**Visual:**
- Text on screen: "Last week, my agent could spend money."
- Elements: Warden dashboard, Policy tab, global-default empty state, wordmark top-left.

**Voiceover:**
> "Last week my agent could spend money. This week, I decide the terms — and it can't get around them."

**Animation (GSAP):**
- Entry: Headline `tl.fromTo('#headline', { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, 0.2)`; screenshot wrapper scales in from 0.96 → 1.0 with a matching fade.
- During: subtle Ken-Burns drift on the screenshot (`scale 1.0 → 1.03` over the full window).
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 2: SET THE RULE

**Window:** 6s → 14s (8s)
**Scene file:** `scenes/01-set-rule.html`
**Screenshot:** `public/screenshots/scene-01-policy-filled.png`
**Capture:** screenshot

**Visual:**
- Text on screen: "Set the budget. Approve the merchant."
- Elements: Policy editor filled in for `shopping-agent` — allowed merchant "Staples", per-task budget $40.00, per-merchant cap Staples $25.00 — captured just before Save.

**Voiceover:**
> "Here's the policy editor. I set my shopping agent's budget to forty dollars, tell it Staples is approved, cap that merchant at twenty-five. Save. New version, live immediately — no redeploy."

**Animation (GSAP):**
- Entry: crossfade from scene 1's screenshot into this one; form fields highlight sequentially with a soft glow pulse timed to the VO's "budget... merchant... cap" beats.
- During: none beyond the field highlights.
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 3: SAVED

**Window:** 14s → 19s (5s)
**Scene file:** `scenes/02-saved.html`
**Screenshot:** `public/screenshots/scene-02-policy-saved.png`
**Capture:** screenshot

**Visual:**
- Text on screen: "Live immediately. No redeploy."
- Elements: Policy editor showing "✓ saved as version N" confirmation and the version-history table (new version active, prior version superseded).

**Voiceover:**
> (continues from scene 2's line — no new VO in this beat, just a 1–2s hold on the confirmation)

**Animation (GSAP):**
- Entry: the "✓ saved" badge pops in with a small overshoot (`power2.out`, scale 0.8 → 1.0).
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 4: ENFORCEMENT

**Window:** 19s → 35s (16s)
**Scene file:** `scenes/03-enforcement.html`
**Capture:** terminal *(authored from real `demo-agent.js` stdout — no clip-recording tooling available)*
**Command (for reference, output authored not recorded live):** `node packages/mcp/dist/demo-agent.js ./warden-demo.db --fresh`

**Visual:**
- Text on screen: "Blocked before a card ever existed."
- Elements: Authored terminal window (macOS-style chrome) typing out the real narrated lines from the demo agent: task start → card issued at Staples → settled → the prompt-injection attempt at the blocked merchant → `POLICY_BLOCKED` → "no card ever existed for this purchase — nothing to steal, blast radius $0".

**Voiceover:**
> "Now watch the agent try to buy from a merchant that isn't on the list — a prompt-injected page telling it to buy a gift card. Blocked, before a card ever existed. No card, nothing to steal."

**Animation (GSAP):**
- Entry: terminal window frame fades/scales in; lines type on progressively, timed so the `POLICY_BLOCKED` line lands under "Blocked" in the VO.
- During: the blocked line gets a red-tinted highlight sweep.
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 5: THE RECEIPT

**Window:** 35s → 47s (12s)
**Scene file:** `scenes/04-receipt.html`
**Screenshot:** `public/screenshots/scene-04-receipt-drawer.png`
**Capture:** screenshot

**Visual:**
- Text on screen: "Every dollar, with the why."
- Elements: Receipt drawer open — "Why this charge happened" intent quote, policy decision JSON, card status line.

**Voiceover:**
> "Every approved charge still lands here — the merchant, the amount, and the exact instruction that caused it. This is the record Visa and Mastercard now require for agentic payments."

**Animation (GSAP):**
- Entry: drawer slides in from the right (matches its real in-app motion), intent quote line highlights.
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 6: MULTI-RAIL TEASE

**Window:** 47s → 57s (10s)
**Scene file:** `scenes/05-multirail.html`
**Screenshot:** `public/screenshots/scene-05-dual-rail.png`
**Capture:** screenshot

**Visual:**
- Text on screen: "One policy. Two card networks."
- Elements: Receipts table showing both an AgentCard-rail receipt and a Stripe-rail receipt with their rail badges visible side by side.

**Voiceover:**
> "And this same policy, same receipt — now works across two different card networks, not just one. More on that soon."

**Animation (GSAP):**
- Entry: crossfade in; the two rail badges (indigo AgentCard, green Stripe) each get a small scale-pulse in sequence.
- Exit: handled by transition.

**Transition to next:** Fade 0.7s

---

### Scene 7: CLOSE

**Window:** 57s → 60s (3s)
**Scene file:** `scenes/06-close.html`
**Capture:** *(pure design scene — no screenshot)*

**Visual:**
- Text on screen: "Warden — every dollar, with the why."
- Elements: Wordmark centered on the product's own off-white background, no chrome.

**Voiceover:**
> "Warden. You set the terms, every dollar explained."

**Animation (GSAP):**
- Entry: wordmark fades/scales in centered, `power3.out`.
- Exit: this is the closing scene — a gentle fade-to-hold is fine here (only scene allowed an exit animation).

**Transition to next:** *(end of composition)*
