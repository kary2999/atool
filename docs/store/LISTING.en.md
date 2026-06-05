# Chrome Web Store Listing (English)

---

## Name (≤ 45 chars)

```
DevToolbox — WebSocket + Dev Tools
```

## Short description (≤ 132 chars)

```
Inspect WebSocket frames plus a built-in toolbox: multi-language SQL gen, QR codes, JSON formatter, timestamp converter, text diff.
```

## Category

`Developer Tools`

---

## Detailed description

```
DevToolbox is a developer toolbox extension for Chrome.
Built around a mature WebSocket interceptor/debugger, it bundles the
small utilities you reach for every day into one dark, three-column panel —
switch and use, no more jumping between scattered web tools.

═══════ NEW IN 2.0 — DEV TOOLS GROUP ═══════

⛁ SQL Generator — type Chinese source text, auto-translate to 18 languages
   and produce static_lang / static_lang_error INSERT SQL, syntax-highlighted,
   one-click copy
⌕ SQL Search — paste existing INSERT statements, filter live by source /
   error_tag / any text, highlight matches, inspect & copy a single row
▦ QR Code — turn text or links into a QR code (CJK supported), adjustable
   error-correction level and pixel size, export PNG
❴❵ JSON Tools — format / minify / strip comments / sort keys / escape /
   unescape, with validation
◷ Date & Time — timestamp ↔ date conversion, multi-timezone (input is
   interpreted in the selected zone), seconds / ms / ISO / weekday at a glance
⇄ Text Diff — line-by-line diff of two texts, additions green & deletions red,
   with add/remove line counts

═══════ WEBSOCKET INSPECTOR CORE ═══════

✓ Intercepts all WebSocket connections on the page (including dynamic ones)
✓ Auto-decompression — gzip / deflate / deflate-raw, magic-byte detection
✓ Four detail views: Decoded JSON (syntax highlighted) · Raw · Hex · Info
✓ Active connections — open ws:// or wss:// endpoints directly from the panel
✓ Heartbeat keep-alive + auto-reconnect with exponential back-off
✓ WSS Diagnostics — DNS → TLS → handshake step timeline, endpoint reachability
✓ Subscription rules — auto-send frames on connect (auth tokens, subscribe payloads)
✓ Message highlighting (keyword / regex / JSON-path), pin, direction filter
✓ Send templates, right-click menu (copy / resend / pin / delete), JSON export

═══════ TWO DISPLAY MODES ═══════

① DevTools Panel  (F12 → "DevToolbox" tab)
   Embedded alongside Chrome DevTools Network / Console panels

② Browser Side Panel  (click toolbar icon)
   Docked to the right of the page, auto-follows tab switches — no DevTools required

═══════ WHO IS THIS FOR ═══════

• Frontend / full-stack engineers debugging WebSocket APIs, live feeds, chat
• Backend / QA engineers generating & searching multi-language string SQL,
  verifying push payloads
• Protocol analysts inspecting market-data feeds, IM, or game-client traffic
• Anyone needing quick QR / JSON / timestamp / text-diff utilities

═══════ PRIVACY ═══════

• WebSocket capture / decode / diagnostics / send — 100% local, data never leaves your machine
• QR / JSON / Date & Time / Text Diff — all computed locally, no network
• ⚠ Sole exception: the "SQL Generator" multi-language translation sends your
  input text to Google Translate (translate.googleapis.com) to fetch translations;
  if you don't use that feature, the extension makes no outbound requests
• No user identity collected or stored; captured messages live only in memory
• Fully open source and auditable

═══════ HOW TO USE ═══════

1. Install the extension
2. Click the toolbar icon for the Side Panel, or press F12 → DevToolbox tab
3. Capture: open any page using WebSocket and reload — frames appear, grouped by connection
4. Tools: switch SQL / QR / JSON / Time / Diff under the "Tools" group in the left nav
5. Each tool: input on the left, live results on the right, one-click copy / export
```

<!-- ⚠️ Privacy section truthfully notes the SQL Generator calls Google Translate; keep this exception, it must match manifest host_permissions. -->
