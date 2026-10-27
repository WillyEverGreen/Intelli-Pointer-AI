# IntelliPointer desktop app — developer guide

Electron app for Windows. Plain JavaScript (CommonJS in the main process,
classic scripts in the renderers), no bundler, no framework: every file is
loaded as written, which keeps startup fast and the code easy to follow.

```
desktop/
├── src/
│   ├── main/                    Main process (Node.js)
│   │   ├── main.js              App lifecycle, windows, tray, shortcuts, IPC
│   │   ├── capture.js           Selection overlays + screen capture
│   │   ├── selection.js         Bridge to the native helper (selected text, screen grabs)
│   │   ├── native/
│   │   │   ├── selection-helper.cs    Native helper source (C#): mouse hook, UI Automation, BitBlt
│   │   │   └── selection-helper.ps1   Fallback launcher if the compiled helper is unavailable
│   │   ├── api.js               Streams answers from the chosen provider (cancel, cache)
│   │   ├── providers.js         Direct providers: Gemini, Groq, OpenAI-compatible (9Router, Ollama…)
│   │   ├── commands.js          Command defaults + validation
│   │   ├── settings.js          Non-secret preferences (JSON) + migrations
│   │   ├── secrets.js           Provider API keys, encrypted with Windows DPAPI
│   │   ├── updater.js           Automatic updates from GitHub Releases (electron-updater)
│   │   ├── clipboard.js         Clipboard snapshot/restore (async API)
│   │   ├── ocr.js               Local OCR (tesseract.js), loaded on demand
│   │   ├── log.js / latency.js  Diagnostics log and per-request timings
│   │   ├── sse.js / icon.js     SSE parser; app icon drawn in code
│   ├── preload/                 One minimal, explicit bridge per window
│   └── renderer/
│       ├── shared/              theme.css (design tokens, light/dark), icons.js (generated)
│       ├── panel/               Floating panel
│       │   ├── panel.js         Context, conversation, composer
│       │   ├── model-menu.js    Model picker component
│       │   ├── settings-view.js Settings: Models, Commands, Shortcuts, General
│       │   └── shortcut-input.js Shortcut recorder component
│       ├── overlay/             Screen selection overlay and drawing tools
│       └── bubble/              Ask bar shown next to selected text
├── scripts/
│   ├── prepare-build.js         Icons and build stamp for a release build
│   ├── after-pack.js            electron-builder hook: compiles the native helper into the app
│   ├── smoke-test.js            Starts a built app and checks every window and library loaded
│   ├── build-helper.js          Compiles the native helper with the Windows C# compiler
│   ├── build-icons.js           Generates shared/icons.js from Lucide
│   └── check.js                 Syntax-checks every file (npm run check)
└── test/                        Unit tests (*.test.js) and Electron tests (*.e2e.js)
```

## How the pieces connect

- **Windows** are created once by the main process and reused: the panel, one
  overlay per display, and the Ask bar. Renderers run sandboxed with context
  isolation; each talks to the main process only through its preload bridge.
  No renderer sees an API key, token or the network.
- **Screen region (Alt+Shift+S):** `main.startCapture` → `capture.startSelection`
  shows the overlay at once (it is transparent and content-protected, so it is
  excluded from screenshots), then asks the native helper for a BitBlt copy of
  the screen, which the overlay swaps in as a frozen background. Crops are made
  in the overlay at physical resolution and sent back; OCR runs in the main
  process while the panel already shows the thumbnails.
- **Selected text (Alt+Shift+A / Ask bar):** `selection.js` asks the helper
  (UI Automation first, then a Ctrl+C round trip that restores the clipboard).
- **Asking:** `panel.js` builds the messages; `api.ask` streams from the chosen
  source (`providers.js`: Gemini, Groq or a local OpenAI-compatible server)
  and relays events to the panel.

## Extending

- **A command:** users add them in Settings → Commands. To change the defaults,
  edit `DEFAULT_COMMANDS` in `src/main/commands.js`.
- **A provider:** add it to `DEFS` in `src/main/providers.js` (model listing +
  streaming), then add a pane in `panel/panel.html` and its id to `PROVS` in
  `panel/settings-view.js`. OpenAI-compatible services need only a base URL.
- **An icon:** add its Lucide name to `scripts/build-icons.js` and run
  `npm run icons`.
- **The native helper:** edit `selection-helper.cs`; the protocol is
  documented at the top of that file. The app rebuilds it automatically when
  running from source; the installer builds it into the packaged app.

## Performance budget

| | Target | Measured (1920×1080 @ 125 %) |
|---|---|---|
| Overlay on screen after Alt+Shift+S | < 100 ms | 6–33 ms |
| Screenshot frozen in | < 600 ms | 109–195 ms |
| Shortcut to finished crop | < 1 s | 229–292 ms |
| Native helper memory | < 40 MB | 16 MB |
| App memory at idle (private) | as low as possible | ~165 MB plus 16 MB helper |
| Idle CPU | < 2 % | 0–0.2 % |

How: GPU acceleration off by default (software rendering is as fast for this
UI and saves ~100 MB), a 13 KB compiled C# helper instead of a PowerShell host,
OCR loaded only when a capture starts and unloaded after 5 idle minutes,
render loops that stop when hidden, no default menu, spare renderer and
unneeded Chromium features disabled, unused language packs removed.

## Commands

```bash
npm start                    # run from source
npm run check                # syntax-check every file
npm test                     # unit tests (incl. the compiled helper)
npx electron test/ui.e2e.js  # panel, model menu, settings, commands
npm run dist                 # build the NSIS installer into dist-installer/ and smoke-test it
```

The Electron tests (`test/*.e2e.js`) open real windows. Tests that capture the
screen or use the clipboard need an unlocked, awake display; they report
`SKIP` instead of failing when the screen is locked.

## Releases and automatic updates

`npm run dist` builds `dist-installer/IntelliPointer-AI-Setup-<version>.exe` with
electron-builder (NSIS, per-user, no admin). The packaged app contains
`app-update.yml`, which points `electron-updater` (`src/main/updater.js`) at this
repository's GitHub Releases. Pushing a `v<version>` tag runs
`.github/workflows/release.yml`, which publishes the installer, `latest.yml` and
the blockmap; installed apps find the new `latest.yml`, download the difference
and install it on quit. The artifact name has no spaces on purpose: GitHub
renames spaces to dots, which would break the URL recorded in `latest.yml`.
