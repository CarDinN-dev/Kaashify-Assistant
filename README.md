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

## Choose AI models

Open **Settings → Keys → AI models** to choose Gemini, NVIDIA, Anthropic,
or OpenAI and enter the provider’s exact model IDs. **Fast** and **Smart**
are used for chat. **Screen** is used for screenshots, pointing, and Hands.
A blank field uses the provider’s built-in model for that feature. You can
use the same vision-capable model in all three fields.

For example, NVIDIA lists `google/gemma-4-31b-it` alongside the built-in
Nemotron model. Your NVIDIA key must have access to the model you choose.
Use **Test** beside a model field to check the ID with your saved key. The
screen test uses a generated color sample. Exact local app launches and
hands-free dictation still run on your device.

## Quick Ask and dictation

Say **Open Notepad** with the talk key or enter it in floating Quick Ask.
Exact matches for installed apps launch locally. For one-shot dictation,
say **Open Notepad and then type**, then say the line you want to enter.

For hands-free dictation, focus a text field in Windows and say **Start
typing** with the talk key, or enter it in Quick Ask. Release the talk key
and wait for **Dictating**, then speak normally. Kaashify inserts finalized
speech in the selected window using its local speech model. Another window
coming forward pauses dictation and closes the mic. Return to the original
window and use **Start typing** to resume. Say **Kaashify, stop typing** while
dictating, enter **Stop typing** in Quick Ask, or press **Esc**. A session
ends automatically after five minutes. If **Open mic** is enabled, start
hands-free dictation from Quick Ask.

## Prepare emails, surveys, and documents

Turn on **Hands** in Settings on Windows. Type the request in Quick Ask or
use the talk key.

- Say **Open 7-Zip File Manager** or give another exact Start menu app name.
  If multiple installed apps match, select one in Quick Ask.
- Say **Draft an email in Gmail to pat@example.com saying the notes are ready**.
  You can use Gmail or Outlook on the web in Chrome or Edge, or Outlook for
  Windows. Leave the draft open and review the recipient and text before you
  choose **Send**.
- Open a survey in Chrome or Edge and say **Fill this survey with rating Good
  and comment Thank you**. Kaashify uses the answers you give it and leaves
  the final **Submit** step for you. The configured Screen model receives an
  image of the target window when capture is available.
- Say **Write a packing list in Word** or select text in Word or Notepad and
  say **Rewrite the selected text in Word**. Name and save the document in
  its editor.

Hands verifies the window, page, and control before it edits. Some app
versions and custom forms expose incomplete accessibility information. If
Kaashify pauses, check the open window. **Esc** stops the current task.

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
