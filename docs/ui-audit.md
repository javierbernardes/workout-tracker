# UI audit against the Apple Design skill

> **Status (2026-10-21, after the rework):** all P1/P2/P3 rows below are done, in eight
> commits (`Add motion and design-token foundations` → `Polish pass`). Corrections to the
> audit: Chart.js was already drawn with `animation: false`, so no chart-animation change was
> needed. Deliberately *not* done: swipe-paging between Week/Weight/Strength (buttons are
> enough; a second horizontal gesture next to the week swipe would fight it), haptics (no
> meaningful moment earns one yet), a desktop top-bar material for the header (it scrolls away;
> it isn't navigation), set-row exit animation (a leaving row would still count as a set while
> animating; removal stays instant). Motion is vendored (`motion.min.js`), not npm-installed,
> because the project has no build step and must work offline.

Audited 2026-10-21, before any edits. Source of truth: `apple-design/SKILL.md`
(emilkowalski/skills). Section numbers below (§1–§16) refer to that file.

## 1. Stack and constraints

| | |
| --- | --- |
| Framework | None. Plain `index.html` + `style.css` + `app.js` (2,433 lines), no build step, no npm. |
| Styling | One hand-written CSS file. Colors are CSS variables; everything else (spacing, radii, type sizes) is hard-coded px/rem. |
| Animation | **None.** No `transition`, no `@keyframes`, no `requestAnimationFrame`. Every state change is a hard cut via `hidden` / `.active`. |
| Component library | None. Chart.js 4.4.1 from cdnjs (has its own 1 s eased animation on every draw). |
| Offline | `sw.js` caches the app files + Chart.js by name. Any new file (a motion library, a tokens file) must be added to `APP_FILES` and the cache name bumped. |
| Constraints from `CLAUDE.md` | "No installs if possible (no Node, no build tools)." The site is static GitHub Pages. ⇒ Motion should be loaded from a CDN the same way Chart.js is, not via npm. Plain English comments, beginner-readable code. |
| Testing | No dev server, lint or type-check exists. Plan: `node --check app.js`, a throwaway `python3 -m http.server`, and Playwright screenshots (Chromium is available here). The user tests the real thing on iPhone. |

## 2. Every UI surface

| # | Surface | Where | What it is today |
| --- | --- | --- | --- |
| S1 | Tab bar | `nav` | 4 tabs. Phone (<600px): fixed bottom bar, opaque, 1px top border, icons. Desktop: row of outlined buttons; active = filled blue. Switch = instant hard cut, `scrollTo(0,0)` jump. |
| S2 | Header | `header` | Title + sync status text ("Synced ✓", "2 waiting…"). Scrolls away with the page. |
| S3 | Log home | `#type-picker` | Today box (kcal, wake time + hidden time picker), "▶ Start a workout", running-workout card with live timer + exercise list, 2×2 type buttons. |
| S4 | Entry forms (×6) | `#form-wake/-finish/-weights/-cardio/-sports/-bodyweight` | Replace the Log home in place (`hidden` toggle). "← Back" text button. Also opened from History for editing (switches tab + opens form, two hard cuts). |
| S5 | Weights set rows | `#sets`, `#add-set` | Rows appended/removed instantly. "×" remove per row. |
| S6 | "Last time" banner | `.last-time` | Dashed blue box with a "Use these" button; appears/disappears instantly when the exercise name changes. |
| S7 | History | `#history` | Filter chips (All/Workouts/Sports/Weight), day headings, entry cards. Tap card = edit; "×" = native `confirm()` then delete. Workout cards nest tappable exercise lines. |
| S8 | Running-workout exercise list | `#workout-items` | Lines with "×" → native `confirm()`. |
| S9 | Progress: segmented control | `.segmented` | Week / Weight / Strength. Active = filled blue; views swap instantly. |
| S10 | Progress: Week | `#view-week` | `‹ This week ›` buttons, stat tiles, bar chart, day list. Week change = instant re-render + Chart.js 1 s animation. |
| S11 | Progress: Weight | `#view-weight` | Stat row, range pills (1M/3M/1Y/All), two chart cards (main has 2px blue border), weekly table. |
| S12 | Progress: Strength | `#view-strength` | `<select>` of exercises, stats, chart, sessions list. |
| S13 | Profile | `#profile` | Three stacked cards: profile form, morning-notification box, account (sign-in form or "Signed in as"). Sign out → native `confirm()`. |
| S14 | Morning routine | `#morning` | Full-screen opaque overlay, two steps (wake-up → weigh-in). Steps and the overlay itself appear/vanish instantly. `<details>` disclosure for manual time. |
| S15 | Toast | `#toast` | Solid pill at the bottom; pops in/out instantly after 2 s. Also used for validation errors and "Undo"-less confirmations. |
| S16 | Native dialogs | `confirm()` ×4 | Remove exercise, discard workout, delete entry, sign out. Browser-styled, blocking, un-animated. |
| S17 | Loading / empty / error / offline | various `.hint` text | "No weigh-ins yet", "No exercises yet", "Charts need an internet connection", sync status in header, errors as toasts. Plain muted text; no skeletons; consistent but unstyled. |

There are no menus, popovers, drawers, carousels or sliders today. The only
"sheet-like" surfaces are the forms (S4) and the morning overlay (S14).

## 3. Grades per skill section

Legend: ✅ fine · ⚠️ partial · ❌ violates · — not applicable

| Skill section | Grade | Evidence |
| --- | --- | --- |
| §1 Response (press on pointer-down) | ❌ | Not a single `:active` rule. Only `.type-btn:hover` and `.entry:hover` (desktop-only). Every button, tab, chip and card is dead until release. |
| §1 Latency | ⚠️ | No artificial delays on the input path (sync debounce 300 ms is network-side, fine). But Chart.js re-animates for ~1 s on every tab open / week change / range change, which reads as lag. Native `confirm()` blocks the thread. |
| §2 1:1 direct manipulation | — / ❌ | Nothing is draggable yet. Where drags would be natural (dismiss a form sheet, swipe a History card, swipe between weeks) there is a button instead. |
| §3 Interruptibility | ❌ (once motion exists) | Today there is no motion, so nothing can be interrupted — but also nothing can be *grabbed*. Rule for the rework: no CSS transitions on gesture surfaces; springs from the live value. |
| §4 Springs | ❌ | None. |
| §5 Velocity handoff | — | No gestures. |
| §6 Momentum projection | — | No gestures. |
| §7 Spatial consistency | ❌ | Forms don't come from anywhere — the picker vanishes and a form appears in the same box. Editing from History teleports to the Log tab. Toast has no origin. Morning overlay blinks in. |
| §8 Hint in gesture direction | — | No gestures. |
| §9 Rubber-banding | — | No scroll-driven or bounded drags. |
| §10 Gesture details (hysteresis, cancel-by-drag-away) | ⚠️ | Native buttons give cancel-by-drag-away for free; nothing custom yet. |
| §11 Frame smoothness (transform/opacity only, `will-change`) | ⚠️ | No animated properties at all; layout thrash happens instead (`hidden` toggles reflow whole sections). |
| §12 Materials & depth | ❌ | Phone tab bar is opaque `var(--card)` with a 1px `border-top` — exactly the "opaque bar + hard divider" the skill calls out. No translucency anywhere. Morning overlay is a flat opaque sheet. Cards are border-only, no depth hierarchy (main chart uses a 2px border to shout). |
| §12 Scroll-edge effects | ❌ | Content scrolls under nothing; the only floating chrome (tab bar) uses a 1px line. |
| §12 Dim to focus vs separate to keep flow | ⚠️ | Morning routine is a modal task but has no scrim/push-back (it's opaque). Nothing else is modal. |
| §13 Multimodal feedback | ⚠️ | No haptics or sound (fine — "utility"). Only the toast; it fires after the save, not on the same frame as the visual change. |
| §14 Reduced motion / transparency / contrast | ❌ | None of the three media queries exist. Trivially "compliant" now because nothing moves; must be built in from day one of Phase 2. Dark↔light switch is an abrupt jump (skill: ease it). |
| §15 Typography: size-specific tracking | ❌ | Zero `letter-spacing` rules. Display sizes (`.morning-step h1` 1.8rem, `.today-value` 2rem, `.big-weight input` 2.6rem, `.stat-value` 1.6rem) all run at default tracking (too loose). Body is fine at 0. Small labels (0.75–0.8rem) get no positive tracking. |
| §15 Leading tracks size inversely | ❌ | No `line-height` set anywhere except `.morning-emoji`. Headings use the browser default (~1.2); body gets ~1.15–1.2 too (should be ~1.5). |
| §15 Hierarchy from weight+size+leading as a set | ⚠️ | Weight is used (600/700) but sizes are ad hoc (0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.15, 1.2, 1.3, 1.4, 1.6, 1.8, 2, 2.6 rem — 15 sizes). Needs a scale. |
| §15 Respect text-size setting (rem/em spacing) | ❌ | Almost all padding/gaps/radii/widths are px (`padding: 10px 12px`, `gap: 12px`, `height: 260px`, `grid-template-columns: 32px 1fr 1fr 36px`). A bigger system font breaks nothing dramatically but doesn't scale the layout with it. |
| §15 System font | ✅ | `system-ui, -apple-system, …`. Keep. `tabular-nums` on the timer. ✅ |
| §16-1 Purpose | ✅ | Feature set is tight and personal. Nothing to cut. |
| §16-2 Agency / forgiveness | ⚠️ | Four `confirm()` dialogs and **no undo**. Skill: undo for slips, confirmation only for genuinely destructive, irreversible acts. "Remove this exercise?" and "Delete this entry?" are slips-with-undo territory; "Discard whole workout" and "Sign out" (loses offline-only data) earn a confirmation. |
| §16-4 Familiarity / consistency | ⚠️ | Three different "selected" looks: tabs (filled blue), segmented (filled blue), range/filter chips (outlined blue). History filter and Weight range use the same `.range-buttons` class but mean different things. "×" is used for both *remove from running workout* and *delete forever*. |
| §16-5 Flexibility (phone vs desktop) | ✅ | Bottom bar on phone, top tabs on desktop; safe-area insets handled. |
| §16-6 Simplicity, not minimalism | ⚠️ | Mostly good. Noise to remove: dashed borders (`.secondary`, `.last-time`), emoji doing icon duty in 20+ places (fine on iOS, inconsistent elsewhere), "The one to watch" badge, 2px shouting border, `opacity: .85` on the secondary chart card. |
| §16-7 Craft | ⚠️ | Timer uses `tabular-nums` ✅, dark mode ✅. But `scrollTo(0,0)` jumps, Chart.js default easing, charts hidden/shown with `hidden` (canvas resize flicker), no focus-visible styling for keyboard users beyond inputs. |
| §16 Wayfinding | ⚠️ | "Where am I": tab highlight ✅, form `h2` ✅. "How do I get out": "← Back" is a small text link at the top; no swipe-down, no Escape. Edit-from-History hides which tab you're on (you're on Log but came from History). |
| §16 Specific labels | ✅ | "Log / History / Progress / Profile", "Add to workout", "Save weight", "Finish workout". Good. Minor: "Or log something else:" is a sentence doing a heading's job. |

## 4. Surface → violations → fix → priority

Priority: **P1** = foundation or seen on every screen · **P2** = daily-use surfaces · **P3** = polish.

| Surface | Violations | Fix | Pri |
| --- | --- | --- | --- |
| **Foundations** (new `motion.js` + tokens in `style.css`) | §4 no springs, §14 no reduced-* queries, §15 no type scale, §12 no materials | Motion from CDN (`window.Motion`), spring presets (default damping 1.0 / response 0.35; momentum 0.8 / 0.35), `project()`, `rubberband()`, `pointerDrag()` helper (pointer capture, grab offset, velocity history, 10px hysteresis). Type scale with per-size tracking/leading; rem/em spacing tokens; material tokens; the three reduced-* layers. Add new file to `sw.js` cache. | P1 |
| **Press feedback — every button/card** | §1 nothing on pointer-down | Shared `:active` rules: `transform: scale(.97)` on buttons/cards, background tint on chips/tabs/list rows. 100 ms ease-out on press, spring on release. Hit padding on small "×" targets (currently ~20px; 44px minimum). | P1 |
| **S1 Tab bar** | §12 opaque + 1px divider; §1 no press state; §7 hard cut; `scrollTo` jump | Translucent material (`backdrop-filter`, 60–70% bg, bright top edge, reduced-transparency fallback). Content scrolls under it with a scroll-edge fade mask instead of the border. Active indicator springs between tabs (transform only). Sections cross-fade (opacity only, 150–200 ms; same in reduced motion). Desktop: same material as a top bar. | P1 |
| **S2 Header** | §12 no material; sync status is raw text | Fold into the translucent top chrome on desktop; on phone keep it simple (scrolls away) — it's not navigation. Sync status becomes a small status chip with the same style as the toast family (status feedback, §16). | P3 |
| **S4 Forms → bottom sheet** | §7 no spatial origin; §2/§3 not draggable; §16 wayfinding: tiny "← Back", no swipe-down | Forms become one **sheet** surface: slides up from the bottom (spring, damping 1.0), grabber + "Back" top-left, dismiss by **dragging down** 1:1 with velocity handoff, momentum projection picks open/closed, rubber-band when dragged above the top, commit vs cancel by velocity sign. Interruptible: grabbing a closing sheet reverses it from the live transform. Scrim dims the Log home behind it (modal task) and pushes it back slightly. Same path in and out (down). Reduced motion: cross-fade. Editing from History opens the same sheet *over History* instead of teleporting to Log (wayfinding fix; forms stay in the Log section's DOM, only presentation changes). Desktop ≥600px: same sheet, max-width 600, centered. | P1 |
| **S14 Morning routine** | §12 opaque, no materialize; §7 steps blink; §14 no reduced-motion | Overlay materializes (opacity + scale .96→1 + blur 8→0 px, spring). Wake→weigh step cross-fades/slides up 12px along the same axis both ways. "I just woke up" big button gets the press scale. `<details>` keeps native behavior. Dismiss = fade+scale down (same path). | P2 |
| **S7 History cards** | §16-2 `confirm()` + no undo; §1 no press; §10 "×" is a 20px target; §16-4 "×" means two things | **Swipe left** on a card (1:1, pointer capture, hysteresis, rubber-band past the action width, velocity decides reveal/close) reveals a red **Delete**. Tapping it deletes immediately and the toast offers **Undo** (5 s; re-adds via the existing `addEntry` with the same id — UI-level, no storage changes). Removes `confirm()`. Press feedback on tap-to-edit. Day headings get the small-text tracking. Chips: unify with Progress range chips. *Needs your OK: this replaces a confirmation with undo.* | P2 |
| **S8 Running-workout exercise lines** | §16-2 `confirm()`; "×" 20px | Same swipe-to-remove + Undo as History (removing an exercise mid-workout is a slip-level action). "Discard this workout" keeps a confirmation but as an in-app **action sheet** (slides up from the bottom, destructive button in red, Cancel) instead of the browser dialog. | P2 |
| **S9 Segmented control** | §7 hard swap; §1 no press; §16-4 three "selected" styles | Sliding pill indicator (spring on transform; starts from live position when tapped mid-flight). Views cross-fade. Optional P3: horizontal swipe between Week/Weight/Strength with 1:1 paging + momentum. | P2 |
| **S10 Week ‹ ›** | §2 buttons where a swipe is natural; Chart.js 1 s animation on every change | Horizontal **swipe between weeks**: the week panel tracks the finger 1:1, rubber-bands at "this week" (can't go into the future), release projects momentum to pick prev/this/next, springs with velocity handoff. Buttons stay for desktop/keyboard. Chart.js: `animation: false` on re-render (reduced motion too) and only animate the first draw briefly — interruptibility beats a 1 s tween. | P2 |
| **S11 Weight view** | §16-6 2px shouting border + badge + `opacity .85`; §15 stat sizes untracked; Chart.js animation; range chips | Hierarchy from material weight + typography instead of borders: main chart card gets the "thicker" material (deeper shadow), secondary card plain. Drop badge, dashed/opacity tricks. Stat values get display tracking. Range chips → shared chip style. | P2 |
| **S12 Strength view** | Same as S11 | Same treatment. `<select>` stays native (best on iPhone). | P3 |
| **S3 Log home** | §15 `.today-value` 2rem untracked; §1 Start button no press; running-workout card flat | Type tokens; press feedback; running-workout card uses the "lighter material draws attention" rule (subtle tint rather than a blue border). Timer keeps `tabular-nums`. Appearance of the card when you press Start: scale/opacity spring from the Start button's position (anchored origin, §7). | P2 |
| **S5 Set rows** | Rows pop in/out; "×" small | New row fades/slides in 8px (spring), removal collapses via transform+opacity then DOM removal. Swipe-to-remove is overkill here — keep "×" but with 44px hit area and press feedback. | P3 |
| **S6 Last-time banner** | Dashed border (noise); pops | Tinted card, no dash; enter/exit cross-fade with 6px slide on the same axis. | P3 |
| **S13 Profile** | Three stacked cards with `margin-top:32px`; sign-out `confirm()` | Grouped list style; sign out → action sheet (it's genuinely destructive if offline data is unsynced). Press states. | P3 |
| **S15 Toast** | Pops in/out; solid; no origin; no undo slot | Springs up from the bottom edge (translate + opacity, same path out), material with reduced-transparency fallback, optional **Undo** button. Status messages ("Synced ✓") and errors use the same component. | P1 (needed by History undo) |
| **S16 Native dialogs** | Block, unstyled, inconsistent | Replaced as above: slips → undo; destructive → action sheet (shares the sheet machinery from S4). | P2 |
| **S17 Empty / offline / loading** | Fine but unstyled | Keep text, apply the small-text token; no spinners added (sync is background). "Charts need internet" stays. | P3 |
| **Dark ↔ light** | §14 abrupt jump | `color-scheme` + short easing of `background`/`color` on `body` only (not a gesture, CSS transition is allowed here), disabled under reduced motion. | P3 |
| **Keyboard / a11y** | No `:focus-visible` styling on buttons; sheet has no Escape | `:focus-visible` rings everywhere; Escape closes the sheet/action sheet; `role="dialog"` + `aria-modal` on sheets; swipe actions keep a visible Delete button alternative (long-press/keyboard: the "×" stays, visually quieter). | P1 (with foundations) |

## 5. Proposed order of work

1. **Foundations** — `motion.js` (CDN Motion + presets + `project`/`rubberband`/`pointerDrag`), type/spacing/material tokens, reduced-* layers, press-feedback rules, `:focus-visible`, `sw.js` cache update. *One commit.*
2. **Tab bar + section switching** — material bar, scroll-edge fade, sliding indicator, cross-fade.
3. **Toast** — spring in/out, Undo slot (the History work depends on it).
4. **Forms as a draggable bottom sheet** — the biggest gesture surface; includes edit-from-History staying on History, action sheet for "Discard workout" / "Sign out".
5. **History + running-workout list** — swipe-to-delete with Undo, press states, unified chips.
6. **Morning routine** — materialize, step transitions.
7. **Progress** — segmented indicator, swipe between weeks, chart animation policy, card hierarchy via material, typography.
8. **Log home, set rows, last-time, Profile, dark/light easing** — the P3 polish pass.

Each step is one commit, naming the skill sections it addresses.

## 6. Decisions I need from you before Phase 2

1. **Motion from a CDN, not npm.** Your notes say "no installs". Chart.js already loads from cdnjs, so I'd load Motion the same way (pinned version, cached by `sw.js`). The alternative is a ~60-line hand-written spring in `motion.js` with zero dependencies. I recommend the CDN library — it carries velocity through re-targets (the "brick wall" rule in §3), which is the hard part to get right by hand.
2. **Undo instead of "Are you sure?"** for deleting a History entry and removing an exercise from the running workout (swipe → Delete → toast with Undo). "Discard workout" and "Sign out" keep a confirmation, but as an in-app sheet. OK?
3. **Forms as bottom sheets** (slide up, drag down to dismiss) on both phone and desktop, rather than the current in-place swap. OK?

Things I will **not** touch: storage/sync, Supabase calls, calorie math, entry shapes, the morning-reminder function, the service worker's fetch logic (only its file list).
