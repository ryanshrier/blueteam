# Synthetic browser verification

Run `npm run visual:serve`, then open [the fixture index](http://127.0.0.1:4173/).
The server binds only to loopback and uses in-memory synthetic data. It never
imports `server.js`, SQLite, settings storage, or a generation provider. Every
API write returns HTTP 405, including generation and key verification.

The existing standalone renderer fixtures remain available through `?state=…`.
Production-shell routes use the actual application modules, styles, fonts,
navigation, and controls with synthetic API responses:

- [Wall, long BLUF](http://127.0.0.1:4173/wall?operator&scenario=long&kind=bluf)
- [Wire](http://127.0.0.1:4173/wire?scenario=long)
- [Briefing](http://127.0.0.1:4173/briefing?scenario=normal)
- [Complete public sample and saved synthetic receipt](http://127.0.0.1:4173/briefing?scenario=sample)
- [Settings](http://127.0.0.1:4173/settings?scenario=normal)

`scenario` accepts `normal`, `long`, `sparse`, `stale`, `loading`, `sourceerror`,
`brieferror`, `empty`, `changed`, and `evidence`. The evidence fixture includes
linked likelihood reasoning, legacy confidence, and decisions with and without
an Act now field. `kind` accepts `bluf`, `execsummary`,
`judgment`, `developing`, `convergence`, `kev`, or `wire`; it uses the Wall's
keyboard controls to find and pause on that content type. Omit `kind` when
checking unattended playback or loading/error states. The `long` fixture has
seven owner decisions and long claims, directives, descriptions, and tripwires;
`sparse` has every content type plus unusable KEV and Wire records.

Use `theme=light` or `theme=dark` and an optional URL-encoded `accent=%23…` to
set appearance before the production theme boot. Add `capture` to hide fixture
controls for clean screenshots. Appearance choices persist in this origin's
local storage, just as the application does.
Use `reducedMotion` to take stable captures with animations and transitions
suppressed while exercising the production reduced-motion countdown path.

The **Synthetic fixture controls** disclosure has a scenario selector and
**Poll now**, **Status tick**, **Next timer**, and **Show and pause** buttons. These controls are
test-only. Poll now advances a fixture clock enough to expire the real API
cache, then invokes the actual polling callbacks. Status tick advances the
fixture clock and runs the actual status timer. Rendering functions are not
replaced. The current scenario remains active during normal app navigation.
Next timer cancels and invokes the currently scheduled Wall advance callback,
advancing the fixture clock by that page's dwell. It exercises unattended
continuations without waiting through every dwell; paused views have no active
advance timer. Initial kind selection waits for both synthetic data requests
and fonts, then marks `data-fixture-ready="true"` on the body.

Useful transitions to inspect:

1. Load `normal`, pause, select `sourceerror`, then Poll now. The previous content
   must remain available while the failure stays visible after Status tick.
2. Select `normal` and Poll now to inspect recovery without remounting the Wall.
3. Pause on a Judgment or Convergence in `normal`, then apply `changed`. This
   changes the saved edition date and removes several page kinds. Content,
   current section, date, pager, and pause status must remain aligned until the
   operator resumes or changes pages.
4. Open `loading` and inspect the opening state. The production API timeout
   occurs after 15 seconds; a later successful Poll now exercises recovery.
5. Open `brieferror` to retain feed pages while the saved Briefing is unavailable.

The test clock is synthetic. Browser rendering still needs visual inspection at
1920×1080, 1280×720, and a roughly 390px-wide viewport; unit tests do not prove fit.
Use the production Previous/Next and Pause/Resume buttons and keyboard shortcuts
to verify operation. Fixture controls are supplementary and are never shipped
in the production shell.

Settings health scenarios are `health-healthy`, `health-degraded` (HTTP 503 with
structured diagnostics), `health-unavailable`, `health-loading`, and
`health-minimal` (the limited response available outside the trusted boundary).
Select a scenario, choose Poll now, then use the production Refresh diagnostics
button to check retained results and recovery. `no-key`, `settings-loading`, and
`settings-unavailable` exercise the contextual Generate control in Briefing.

For clipboard verification, add `clipboard=capture` to capture the exact text
passed to `navigator.clipboard.writeText` in the fixture's read-only
`#fixtureClipboardOutput` textarea. It is DOM-readable with `capture` hiding the
controls. Use `clipboard=denied` to reject clipboard writes and inspect the
production error or selectable diagnostics fallback. Without either parameter,
the fixture does not replace the Clipboard API.

Wire uses real browser storage on this isolated origin. Hide several signals,
wait for instant Undo to expire, reload, and use Hidden to restore them. Check
filtered Hidden results, read/unread preservation, individual Restore, Restore
all, export scope, and keyboard focus after returning to visible signals.

## Retained evidence milestone

`/wire?scenario=source-revision` shows a fictional changed advisory with two
separately attributed sources and a declared Gateway watch match. Open **Inspect
evidence (2)**, compare the affected-version/fix passages, switch sources, expand
the older revision, then press Escape. `/wire?scenario=evidence-unavailable`
exercises a retained-evidence request failure and Retry. The normal fixture has
no retained references and explicitly explains that legacy state. Settings
fixtures now provide a synthetic unified watch profile.

`npm run check:evidence:render` automates the real app at 390px and 1280px in both
themes: source comparisons, source switching, 44px targets, horizontal fit, Tab
containment, Escape focus restoration, unavailable evidence, legacy evidence,
Settings, and new/legacy Briefing receipt links. It runs independently of an existing fixture server and rejects
unexpected external requests. Optional `EVIDENCE_SCREENSHOT_DIR` captures PNGs.
This is a bounded first app browser gate, not the entire item-73 matrix.
