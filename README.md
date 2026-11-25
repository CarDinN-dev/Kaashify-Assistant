# Kaashify Assistant

Kaashify is a Windows desktop assistant. Hold Ctrl+Alt and ask about your
screen, or type a question into the floating overlay. Kaashify can answer,
point to controls, walk through a task, or perform supported actions with
Hands. Notes, reminders, and speech processing are available on the device.

## Installation

Open the [latest release](https://github.com/CarDinN-dev/Kaashify-Assistant/releases/latest),
follow the Windows installer link, and choose **Download**. This private
repository requires a signed-in account with access. Run `Kaashify-Setup.exe`
on Windows 10 or 11 x64. The first launch opens the
dashboard and offers a quick tour. Add a Gemini, Anthropic, Nvidia, or OpenAI
key in **Settings → Keys**, or use a signed-in installation of Claude Code.
Kaashify sends the question and, when needed, a screenshot to the chosen
provider. Local voice commands and reminders work without an AI provider.
Saved provider keys use the operating system's credential encryption. If
that service is unavailable, newly entered keys last for the current session.
Automatic import of chat exports is off on new profiles. Enable it under
**Settings → Your notes and AI chats**. Added folders can provide matching
text to your answer provider when their context switch is on.

Kaashify uses its own Windows app identity and stores its profile in
`%APPDATA%\Kaashify`. Feedback opens the
[Kaashify contact page](https://www.kaashify.com/contact). This standalone build
has no account sync, usage telemetry, or hosted update feed.

## Build from source on Windows x64

Use Node.js 24 LTS and npm. Install the pinned dependencies and local models,
then generate and verify the installer.

```powershell
$env:ONNXRUNTIME_NODE_INSTALL = 'skip'
npm ci
npm run setup:voice
npm run setup:embed
npm run dist:companion
npm run dist:check:companion
Get-FileHash -LiteralPath .\dist-companion\Kaashify-Setup.exe -Algorithm SHA256
```

The installer and unpacked app are in `dist-companion`. Electron Builder
creates an unsigned installer when signing credentials are absent. To verify
the startup path on Windows, launch `dist-companion\win-unpacked\Kaashify.exe`
with `--smoke` and a fresh `--data-dir`.

`npm test` runs the standalone regression suite. See [the v0.1.40 audit](AUDIT.md)
for fixes, verification, and remaining Windows hardware checks.

## Reference and licensing

The Windows v0.1.39 installer was verified by SHA-256 before REA 6.10.1
inspected its Electron entry points, IPC preloads, dashboard, overlay, and tour.
Kaashify is based on that source tag. See `NOTICE` for the exact upstream commit
and `LICENSE` and `THIRD-PARTY.md` for the applicable licenses.
