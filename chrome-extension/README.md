# Kaashify Assistant for Chrome

Kaashify Assistant for Chrome connects the active browser tab to the installed
Windows desktop app. The extension carries out the searches, page reads,
navigation and field edits that the user requests in Kaashify. The user confirms
installation in Chrome and pairs the extension from Kaashify.

## Store submission

Build the upload package with `node scripts/package-chrome-extension.js`. The
ZIP contains the manifest, extension scripts, icon and license notices. The
publisher uses the Chrome Web Store Developer Dashboard to submit the ZIP, the
listing material and the required privacy disclosures.

The extension uses Native Messaging to speak to the per-user desktop helper.
Tab and navigation access identify the active tab and document. The content
script needs HTTP and HTTPS access to locate ordinary page controls. Local
storage keeps a random profile identifier and an alarm lets the extension
reconnect after the desktop app restarts. Browser automation stays within the
paired profile and the tab that starts a task or the tabs the task opens.

When a user requests AI help for a Chrome tab, the desktop app can send the
visible page text and control labels to the configured AI provider to interpret
the request. The extension carries no API keys. Password fields and known
private pages are excluded from its observations. Email sends and form
submissions stay with the user.

After the listing is approved, put its extension ID in
`companion/src/chrome/store-listing.json` and build the Windows x64 installer
with `npm run dist:companion`. The build requires the Go toolchain for the
native helper. Validate the approved listing, registration, pairing, task
resumption, cancellation, upgrade and uninstall on an isolated native Windows
profile. Keep the source changes on the local branch until those checks and the
app audit pass.
