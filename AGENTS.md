# Kaashify

The release uses the standalone Windows x64 profile in
`electron-builder.companion.config.js`. Keep the Publik switch off for this
distribution. The packaged profile excludes upstream account, analytics,
feedback, and update clients.

Keep API keys in the existing credential store. Never print or log keys.
Validate the packaged app with `npm run dist:check:companion` after building
and keep the notices shipped with the app.
