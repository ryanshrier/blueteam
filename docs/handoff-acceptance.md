# Download and Print Edition acceptance

[Development guide](development.md)

`npm run check:handoff:render` opens the production application against an isolated,
read-only fixture server. The authored content is fictional. The check uses a new
Chromium profile and never opens the operator database, changes settings, collects
external sources, or generates a paid Briefing.

The Linux CI policy job runs the check and retains a `handoff-acceptance-<commit>`
artifact for 14 days. Review that exact commit's artifact before claiming its
rendered PDF has passed visual acceptance.

## Automated checks

- Activate Wire's Horizon 1 filter, mark one signal read, and use the actual
  CSV/JSON export controls. Observe Chromium's download-completed event, read the
  saved file, and compare its byte length with the receipt. Independently parse
  both files and verify the filtered identities, order, read state, quoted and
  multiline text, and spreadsheet-formula guards.
- Load a saved synthetic edition through the real Briefing route and open Print
  Edition. Require all three judgments, all later sections, loaded self-hosted
  fonts, and both persisted review notes.
- Capture the iframe's generated source and parsed DOM. CDP's `Page.printToPDF`
  operates on a top-level page, so the check installs the unchanged iframe source
  in a blank same-origin target. It verifies identical parsed DOM and CSS before
  asking Chromium to paginate US Letter output with the production print styles.
- Use Poppler to inspect every page's text and physical bounds. Check complete
  paragraphs, actions, warnings, source evidence, and the final verification
  colophon; reject blank pages or text beyond the paper. Render every PDF page to
  PNG and record its dimensions and digest.

The script uses the existing dependency-free CDP launcher. Its acceptance readers
do not import the production CSV serializer or calculate expected PDF content by
reimplementing the Print Edition renderer. The PDF retains the exact production
AI/provenance wording; its body and the artifact report explicitly identify this
as authored synthetic evidence, not a model-generated assessment.

## Review artifacts and limits

`acceptance-report.json` records the browser version, commit when running in CI,
download receipts, file hashes, print options, page dimensions, and checked
passage count. The bundle also includes the received CSV/JSON files, unchanged
print HTML, preview screenshot, `print-edition.pdf`, text extractions, positioned
text, and one `print-page-*.png` per PDF page. Partial artifacts and a failure
screenshot are retained when possible. It contains synthetic data only.

Inspect **every** rendered page for clipping, overlap, missing characters,
unreadable text, awkward page breaks, and separation of headings from their
content. Text and bounding-box checks do not establish visual quality. The PNGs
represent actual PDF pages; the preview screenshot does not establish pagination.

This gate verifies Chromium's download manager and PDF renderer. It does not
exercise the native OS print dialog, a person's Save PDF destination selection,
physical printers, or the production Print button's popup/fallback interaction.
Those require a separate manual check: open Print Edition, choose Print / Save
PDF, save the file, reopen it, and inspect every page. Check browser download
history and reopen the CSV/JSON files when testing their native download UI.

The Chromium gate does not exercise Safari. A separate
`npm run check:safari:render` job on `macos-15-intel` starts the installed Safari
application through Apple's `/usr/bin/safaridriver` and standard W3C WebDriver
HTTP commands. It requires Safari identity/version in returned capabilities and
records the macOS version and actual viewport. It checks the unchanged landing
page, Wire filtering, evidence disclosures with native forward/reverse Tab and
Escape, saved Briefing, Print Edition notes/fonts/fit, Settings hydration and
appearance, and a paused Wall view. No Selenium or generic WebKit package is used.

The macOS 26 Intel runner failed during native Safari session creation, before
opening any application page, despite matching driver/browser versions and
enabled remote automation. The macOS 15 Intel job exercises the same installed
Safari release on a different host OS with every browser assertion retained.
Its result establishes only the browser and OS versions recorded in its artifact;
it does not establish that macOS 26 Safari startup works.

The unchanged landing page is served over loopback HTTPS because Safari applies
its `upgrade-insecure-requests` policy to HTTP loopback assets. The test creates a
one-day certificate, accepts certificate errors only within the isolated
WebDriver session, and removes the temporary key afterward. It does not change
OS certificate trust, TCC permissions, or the page's CSP. This checks page loading
and rendering; it does not validate the deployed site's certificate trust.

Its `safari-acceptance-<commit>` artifact contains screenshots, capabilities,
passed checks, errors and the driver log. The job is required by Release
readiness, but its results must actually pass and its screenshots must be
reviewed before claiming Safari visual acceptance for that commit. This tests
desktop Safari's isolated automation window, not iOS, native downloads, popup
permissions, or the macOS print dialog. A generic WebKit run would not establish
the same browser coverage, and a macOS Node test job alone establishes none.

## Explicit local use

Run only in a browser environment chosen for testing. Install Chrome, Chromium,
or Edge, plus Poppler's `pdfinfo`, `pdftotext`, and `pdftoppm` on `PATH` (on Ubuntu:
`sudo apt-get install poppler-utils`). Set `CHROME_PATH` if needed. Set
`HANDOFF_ARTIFACT_DIR` to a dedicated empty artifact directory; otherwise a new
temporary directory is created and its path is printed. No browser packages or
additional application runtime dependencies are required.

The focused acceptance-reader regressions run without opening a browser:

```bash
npm test -- --runInBand test/handoff-acceptance.test.js
```

Protocol references: [Chromium downloads](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setDownloadBehavior)
and [Chromium PDF output](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-printToPDF).
Safari references: [Apple's Safari WebDriver and isolated automation windows](https://webkit.org/blog/6900/webdriver-support-in-safari-10/),
[WebKit's loopback upgrade behavior](https://bugs.webkit.org/show_bug.cgi?id=250776),
[official macOS runner inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md),
and [the runner's Safari automation setup](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/install-safari.sh).
