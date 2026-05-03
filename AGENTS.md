# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Stack and Platforms

- Language: plain JavaScript, HTML, and CSS.
- Platform: Chrome/Chromium and Firefox extension, Manifest V3.
- Runtime surfaces:
  - `background.js`: MV3 background logic. Chrome loads it as a service worker; Firefox loads it as a background script through `manifest.firefox.json`.
  - `content.js` and `content.css`: page-injected translation UI.
  - `popup.html`, `popup.js`, `popup.css`: extension popup.
- Local API target: OpenAI-compatible LM Studio server, normally `http://localhost:1234/v1/chat/completions`.
- Supported browsers: Chrome/Chromium with Manifest V3 support, and Firefox with the Firefox-specific manifest.

Do not introduce a framework, bundler, transpiler, or TypeScript migration unless the change is explicitly scoped and justified.

## Directory Structure

This project is intentionally flat.

- `manifest.json`: extension metadata, permissions, commands, and MV3 entry points.
- `manifest.firefox.json`: Firefox-specific manifest that uses `background.scripts`.
- `background.js`: settings, dynamic content-script registration, context menu, keyboard command, request cancellation, and LM Studio API calls.
- `content.js`: text collection, page translation state, DOM insertion, SPA navigation handling, selection bubble, and runtime message handling.
- `content.css`: styles injected into translated pages.
- `popup.html`: popup markup only.
- `popup.js`: popup event handling, settings load/save, permission requests, and active-tab content-script injection.
- `popup.css`: popup styling only.
- `README.md`: user-facing install and usage documentation.
- `scripts/prepare-firefox.mjs`: creates `dist/firefox/` with the Firefox manifest renamed to `manifest.json`.
- `LICENSE`: license text.

If the project grows, prefer creating small folders by responsibility, for example `src/background/`, `src/content/`, `src/popup/`, and `docs/`. Do not split files just to satisfy structure; split when ownership and testability improve.

## Non-Negotiable Constraints

- This repository currently has no package manager or build tool. Do not introduce one unless the task explicitly requires it.
- If package tooling is introduced later, follow the project decision documented in the same change and commit the matching lockfile only.
- Do not edit `.git/`.
- Do not change `LICENSE` unless the task is explicitly about licensing.
- Do not add telemetry, remote analytics, account systems, or third-party network calls.
- Keep host permissions narrow. Do not restore `<all_urls>` in `host_permissions` or static `content_scripts`.
- Do not inject HTML with `innerHTML` for translated model output. Use `textContent`, `createTextNode`, and structured DOM APIs.
- Preserve user privacy: page text should go only to the configured local translation endpoint unless an explicit product decision says otherwise.

## Planning Rules

Work directly for small, well-bounded changes:

- Bug fixes with a clear cause.
- Copy or CSS adjustments.
- Small permission or settings changes.
- Focused refactors inside one runtime surface.

Write a short 1-Pager before implementation when the change affects product behavior, permissions, data flow, or architecture. Include:

- Problem and user impact.
- Proposed behavior.
- Permission/privacy implications.
- Files touched.
- Rollout and verification plan.

Use a 1-Pager for new build tooling, new dependencies, TypeScript migration, Rust/native components, persistent storage schema changes, or broad UI changes.

## Before Editing Code

- Read the nearby code first, including call sites and state transitions.
- Identify the runtime boundary: popup, background, or content script.
- Prefer code where intent is visible from names and control flow.
- Keep functions small enough that state changes and side effects are obvious.
- Preserve existing behavior unless the task explicitly changes it.
- Avoid broad refactors mixed with feature work.
- Prefer early returns over deep nesting.
- Add comments only for non-obvious browser-extension behavior, permission constraints, or race conditions.

## Runtime Boundaries

- Background owns extension-level state, storage normalization, optional host permissions, dynamic content-script registration, context menus, commands, API fetches, caching, and cancellation.
- Browser API calls should go through the existing `extensionApi` compatibility wrappers when a call needs to work in both Chrome callback APIs and Firefox `browser.*` Promise APIs.
- Content script owns page-local state, DOM reads/writes, text selection UI, route watching, and translation placement.
- Popup owns user input, active-tab actions, explicit permission prompts, and settings presentation.

If TypeScript is introduced:

- Shared types may live in `src/shared/`.
- Popup/content/background must not import runtime-only APIs from each other.
- Keep browser API wrappers thin and typed.

If Rust or a native bridge is introduced:

- Rust owns CPU-heavy deterministic logic only.
- JavaScript owns browser extension APIs, DOM, permissions, and user interaction.
- The bridge boundary must use typed JSON-compatible messages with versioned schemas.

## Structured APIs

Use structured APIs instead of string concatenation for anything with syntax:

- Paths: use `path.join`, `URL`, or browser URL APIs when tooling is introduced.
- URLs and origins: use `new URL()` and browser match-pattern helpers.
- JSON: use `JSON.parse` and `JSON.stringify`; never hand-build JSON strings.
- Shell commands: pass arguments as arrays in scripts instead of composing unescaped strings.
- DOM: use `createElement`, `append`, `replaceChildren`, `textContent`, and attributes.
- Extension messaging: send objects with explicit `type` fields.

## Size and Complexity Limits

These are targets, not excuses for noisy rewrites.

- File length: prefer under 500 lines. Split above 800 lines when a coherent boundary exists.
- Function length: prefer under 60 lines. Revisit above 100 lines.
- Parameters: prefer 3 or fewer. Use an options object above 4.
- Nesting depth: prefer 3 levels or fewer.
- Cyclomatic complexity: prefer under 10 per function.
- Message payloads: keep runtime messages small and explicit; avoid passing DOM-derived bulk data except translation text batches.
- Batch sizes: keep defaults conservative because local models and MV3 service workers can stall on long requests.

## Upstream and Local Code

There is no vendored upstream code today.

If upstream code or generated assets are added:

- Put them under a clearly named directory such as `vendor/` or `generated/`.
- Treat those directories as read-only during normal feature work.
- Keep local patches outside upstream files when possible.
- Add an update script, for example `scripts/update-vendor.mjs`.
- Add an update checklist documenting source version, command run, files changed, and manual patches.

Before updating upstream code:

- Record the old and new upstream versions.
- Run the update script from a clean working tree.
- Review the diff separately from local feature work.
- Run the full verification flow below.

## Verification Flow

This repository currently has no package scripts. Run these commands after code changes:

```sh
node --check background.js
node --check content.js
node --check popup.js
node --check scripts/prepare-firefox.mjs
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('manifest json ok')"
node -e "JSON.parse(require('fs').readFileSync('manifest.firefox.json', 'utf8')); console.log('firefox manifest json ok')"
node scripts/prepare-firefox.mjs
rg -n "<all_urls>|innerHTML|insertAdjacentHTML|eval\\(" .
```

Manual browser checks:

1. Load the unpacked extension from this folder in `chrome://extensions`.
2. Open an ordinary `http` or `https` page.
3. Click the extension and run page translation.
4. Enable current-domain auto-translate and accept the permission prompt.
5. Navigate to another page on the same domain and confirm auto-translate runs.
6. Navigate to a different domain and confirm auto-translate does not run until enabled there.
7. Select text, right-click, and confirm selection translation works.
8. Disable current-domain auto-translate and confirm new pages on that domain no longer auto-translate.
9. For Firefox, load `dist/firefox/manifest.json` from `about:debugging#/runtime/this-firefox` and repeat the same checks.

If package tooling is added later, define equivalent scripts for the chosen package manager:

```sh
<package-manager> lint
<package-manager> test
<package-manager> build
```

Update this file whenever the stack, permissions model, directory structure, or verification commands change.
