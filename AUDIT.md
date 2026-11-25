# Kaashify Assistant v0.1.40 audit

25 November 2026 · Standalone Windows x64 release · Baseline v0.1.39

## Release verdict

The source, automated regressions, dashboard interaction checks, and Windows
package checks passed. The release is suitable for private pilot use. Native
Windows installation, upgrade, uninstall, and desktop-input verification are
still required before general distribution. This build is unsigned.

## Findings and fixes

| Severity | Finding and impact | Fix and verification |
| --- | --- | --- |
| High | The overlay settings IPC returned raw provider keys. A script running in the overlay could read them. | The settings bridge now returns key-presence flags. Credential inputs stay blank until the user types a replacement. A running Electron check verified both renderers and the settings save response with a synthetic key. `companion/index.js`, `companion/src/store.js`, `companion/renderer/renderer.js` |
| High | The profile and credential stores could write provider keys as plaintext if OS encryption was unavailable. A direct write could also leave settings incomplete on a storage error. | Both stores use OS credential encryption and atomic replacement. Without secure storage, keys are session-only. Loading a readable legacy settings file migrates its keys, and a locked encrypted profile stays intact. Regression tests cover encrypted, session-only, legacy, and failed-save paths. `src/profile-file.js`, `src/secrets.js`, `companion/src/store.js` |
| High | Hands confirmations were shared across actions and could wait indefinitely. A delayed response could apply to a later action. Common navigation words could mask a sensitive action label. | The overlay, pill, and dashboard bind approval to the same per-action identifier. Pending approvals resolve at expiry. Hands checks the active window again for approved input, and stops when it cannot verify typing or the outcome of an approved action. Tests cover stale buttons, expiry, consent labels, and the task panel. `companion/src/hands/consent.js`, `companion/src/hands/agent.js`, `companion/src/tasks/executors/hands.js` |
| High | The dependency audit reported six high and six moderate advisories, including the Electron runtime and packaging dependencies. | Updated Electron to 43.8.13 and Electron Builder to 26.18.1, and pinned patched transitive dependencies in the lockfile. Both the full and runtime-only npm audits reported zero advisories. The rebuilt installer passed extraction and startup checks. `package.json`, `package-lock.json` |
| Medium | Capture-worker dispatch used a loose argument match. Renderer media permissions also covered a broader set of capabilities than the standalone app needed and excluded the dashboard microphone test. | The main process dispatches the fixed bundled worker through its IPC launch path. Trusted top-level app windows can request microphone audio. The dashboard and overlay still use the app's bundled capture worker for screen questions. Electron tests exercised microphone start and stop and denied camera access. The packaged capture worker registered under Wine. `src/main-companion.js`, `companion/index.js` |
| Medium | Folder matching could attach the two latest files to unrelated questions. With TypeSafe configured, candidate descriptions included excerpts from every file considered. | The app ranks matching filenames and text locally, then sends short excerpts from up to eight candidates when TypeSafe is configured. The app checks that a folder is still enabled after matching. A regression test verifies that unrelated queries make no matching request. `companion/home/folders.js` |
| Medium | Reindexing replaced a working folder index before reads and storage writes completed. | A staged scan and database transaction keep the previous index on a failed replacement. The UI reports persistence failures. The regression suite checks a failed replacement after a new cache file has been staged. `companion/home/folders.js`, `src/db.js` |
| Medium | Reminder adds and removals could be acknowledged even when a write failed. Some expired or invalid times were accepted, and a title containing “all” could turn a singular cancellation into a bulk action. | Changes persist before the app acknowledges them. Unreadable reminder files are preserved. Invalid times produce a correction, and targeted cancellation matches whole phrases. Tests cover restart, delivery, cancellation, and a failed write path. `companion/src/reminders.js`, `companion/index.js` |
| Medium | New profiles could automatically import exported chats from Downloads before the user set the preference. Diagnostic files could also retain prompt and typing content. | Automatic import is opt-in on new profiles. Existing profiles keep their saved preference. Routine packaged diagnostics are opt-in and Hands logs omit request, response, and typed text. `companion/src/store.js`, `companion/index.js`, `companion/src/hands/agent.js` |
| Medium | The dashboard marked configured keys and an installed Claude Code binary as ready before a connection test. A provider test could count an empty response as a success. Leaving Settings while a microphone request was pending could leave a stream open when it resolved. | Status labels distinguish configuration from verification. The key test expects an actual response. The microphone test releases media on cancellation, navigation, and late resolution. Live checks covered the microphone and key status with synthetic inputs. `src/main-companion.js`, `companion/home/home.js` |
| Low | The dashboard first showed the Map, Feedback caused a hidden map refresh, Saved tabs lacked keyboard navigation, and narrow windows could clip content. Overlapping history requests could show the wrong conversation. | The dashboard opens directly. Saved tabs use labeled panels and arrow, Home, and End navigation. A skip link and responsive layouts improve navigation. History uses a request sequence to discard stale results. All seven views were checked at 640 px and 440 px in the Electron dashboard. `companion/home/index.html`, `companion/home/home.js`, `companion/home/now.css` |

## Workflow coverage

| Area | Evidence |
| --- | --- |
| Startup and profile | Fresh profile, Windows x64 executable launch under Wine, dashboard, floating overlay, and capture-worker handshake. Automated tests cover settings migration, persistence recovery, and shutdown handling. |
| Dashboard and Saved | Live navigation through Dashboard, My Kaashify, Saved, Map, Folders, Settings, and Feedback. Keyboard navigation, layout sizing, microphone lifecycle, and credential projection exercised in Electron 43.8.13. Automated coverage includes history, recall, and task panels. |
| Voice, guide, and tasks | Mocked provider, capture, and Windows input tests cover voice fallback, walkthroughs, approval, task cancellation, and no-repeat handling. Live microphone checks used a synthetic input device. |
| Local data and privacy | Automated folder matching and transaction tests, note and reminder handling, export checks, and profile encryption behavior. Installer scan checked owned code, required resources, retired services, and known credential and branding patterns. |

## Verification

- Standalone regression suite. 1,431 passed, zero failed, and 36 skipped. Skips
  cover excluded hosted features, unavailable upstream fixtures, or platform
  conditions. The baseline had 27 failures, including platform-specific speech
  fixtures that now run with a portable fixture.
- Fresh source checkout without model and installer assets. 1,429 passed,
  zero failed, and 38 skipped.
- Dependency audits. Zero npm advisories in the full tree and runtime tree.
- Installer. Extracted the Windows setup file and byte-compared its executable
  and ASAR against the unpacked build. Package checks found no missing required
  files, forbidden paths, credential patterns, or legacy branding in the owned
  application code. Apache licensing and attribution are included.

## Remaining verification

1. Run install, upgrade from v0.1.39, and uninstall on native Windows 10 and 11
   x64. Confirm Start with Windows and profile preservation on upgrade.
2. Check physical microphones, accessibility tools, Windows display scaling,
   multiple displays, protected windows, and representative Hands actions on
   Windows. Wine startup and mocked tests cover only part of those workflows.
3. Verify supported providers and signed-in Claude Code with live accounts.
   The audit used synthetic credentials and did not test provider account or
   model availability. The Mac beta was outside this Windows audit.
