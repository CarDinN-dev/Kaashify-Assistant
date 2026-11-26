const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');

// The packed asar sits in a different place per target. An explicit path wins
// (CI passes the mac bundle); otherwise the first unpacked build found is used.
const companionProfile = process.argv.includes('--profile=companion');
const explicitArchive = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const candidates = explicitArchive
  ? [path.resolve(explicitArchive)]
  : companionProfile ? [path.join(root, 'dist-companion', 'win-unpacked', 'resources', 'app.asar')]
  : [
    path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'dist', 'mac-arm64', 'Kaashify.app', 'Contents', 'Resources', 'app.asar'),
    path.join(root, 'dist', 'mac', 'Kaashify.app', 'Contents', 'Resources', 'app.asar'),
  ];
const archive = candidates.find((candidate) => fs.existsSync(candidate));

if (!archive) {
  console.error(JSON.stringify({ ok: false, error: 'packaged_app_missing', looked: candidates.map((c) => path.relative(root, c)) }));
  process.exit(1);
}

const entries = asar.listPackage(archive).map((entry) => entry.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
const retiredServices = /^companion\/src\/(?:publik(?:\/|$)|(?:account|account-link|account-offer|settings-sync|entitlement|stats|updates|channel|one-click|feedback|contact)\.js$)/i;
const forbiddenPaths = entries.filter((entry) =>
  // src/license.js ships in the Companion on purpose since the optional account
  // (accounts stage 5): it reads the account's plan and requires nothing else.
  // Pranav allowed it on 2026-11-03.
  (companionProfile && (/^src\/(config|auth|limits|sync|gcal|outlook|updater|acquisition|main|protocol|draft|logic)\.js$/i.test(entry) || /^renderer\//i.test(entry)))
  ||
  /^(?:docs|scripts|supabase)(?:\/|$)/i.test(entry)
  || /(?:^|\/)\.env(?:\.|$)/i.test(entry)
  || /^(?:src|renderer|companion)\/.*\.test\.js$/i.test(entry)
  || /^(?:deno\.lock|AGENTS\.md)$/i.test(entry)
);

// The standalone archive must never contain src/config.js.
const required = companionProfile ? ['src/main-companion.js', 'src/profile-file.js', 'companion/index.js', 'companion/renderer/index.html', 'companion/home/index.html', 'companion/src/reflex/jev.js',
  'companion/src/chrome/actions.js', 'companion/src/chrome/bridge.js', 'companion/src/chrome/store-listing.json',
  'companion/ui/typography.css', 'companion/ui/Geist-Variable.woff2', 'companion/ui/Geist-OFL.txt'] : ['src/license.js', 'src/limits.js', 'src/main.js', 'renderer/index.html'];
const missingPaths = required.filter((entry) => !entries.includes(entry));
if (companionProfile) {
  // whisper-server keeps the speech model loaded between asks (npm run setup:voice fetches it).
  for (const resource of ['whisper-models/ggml-base.en-q5_1.bin', 'whisper/whisper-cli.exe', 'whisper/whisper-server.exe', 'win/hands.ps1', 'win/probe.ps1',
    'chrome/KaashifyChromeHost.exe', 'chrome/LICENSE-Go',
    'embed-models/all-MiniLM-L6-v2/model_quantized.onnx', 'embed-models/all-MiniLM-L6-v2/vocab.txt',
    'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
    'app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
    'voice/kokoro-multi-lang-v1_0/model.onnx', 'voice-lines/lines.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY.md']) {
    if (!fs.existsSync(path.join(path.dirname(archive), resource))) missingPaths.push('resources/' + resource);
  }
}
const ownedText = entries.filter((entry) =>
  /^(?:src|renderer|companion)\//.test(entry)
  && /\.(?:js|json|html|css|md)$/i.test(entry)
);

const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['stripe_secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['stripe_webhook_secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];
const secretFindings = [];
const brandingFindings = [];
const legacyBrand = /(?:^|[^a-z])(?:n[ūu]s(?![a-z])|potlakai\.github\.io|publikhq\.com|xnpkplcjurzwanotmwwt\.supabase\.co)/iu;

for (const entry of ownedText) {
  const source = asar.extractFile(archive, path.normalize(entry)).toString('utf8');
  if (companionProfile && legacyBrand.test(source)) brandingFindings.push(entry);
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    const count = [...source.matchAll(pattern)].length;
    if (count) secretFindings.push({ file: entry, kind, count });
  }
}

const report = {
  ok: forbiddenPaths.length === 0 && missingPaths.length === 0 && secretFindings.length === 0 && brandingFindings.length === 0,
  archive: path.relative(root, archive),
  packagedEntries: entries.length,
  ownedTextFilesScanned: ownedText.length,
  forbiddenPaths,
  missingPaths,
  secretFindings,
  brandingFindings,
};

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(report));
