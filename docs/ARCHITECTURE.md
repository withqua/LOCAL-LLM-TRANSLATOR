# Translation Architecture

This extension translates visible webpage text with a local OpenAI-compatible LM Studio endpoint. It is intentionally built with plain JavaScript, HTML, and CSS: there is no build step, framework, bundler, or remote analytics.

## Runtime Surfaces

- `popup.js` owns user actions: translate/restore the active tab, save settings, request current-domain auto-translate permission, and clear the in-memory translation cache.
- `content.js` runs inside webpages. It finds translatable DOM elements, inserts loading and translated text, restores pages, watches SPA route changes, and handles selection bubbles.
- `background.js` owns extension state, settings normalization, optional host permission registration, LM Studio requests, cancellation, context menu actions, keyboard commands, and the in-memory translation cache.

Browser APIs go through small compatibility wrappers so Chrome callback APIs and Firefox `browser.*` Promise APIs share the same code paths.

## Translation Flow

1. The popup, context menu, keyboard shortcut, or auto-translate registration sends a runtime message to the content script.
2. `content.js` collects visible text blocks with `TEXT_SELECTOR`, then filters out unsafe or noisy candidates such as inputs, code blocks, existing translation UI, tiny elements, and parent containers that are better represented by child elements.
3. The content script inserts a loading translation element beside each source element.
4. The content script sends text batches to `background.js` with `TRANSLATE_TEXTS`.
5. `background.js` checks the in-memory cache. Cache hits return immediately; misses are batched by character count and sent to LM Studio.
6. LM Studio is prompted to return a JSON array in the same order. The background script parses that array, retries suspicious Korean mojibake-like outputs, stores successful results in memory, and returns translations.
7. `content.js` replaces each matching loading element with the translated output.

Each inserted translation element is linked to its source element with a local `data-llt-translation-id` / `data-llt-source-id` pair. This prevents parent/child DOM structures, especially Discourse and Reddit layouts, from completing the wrong loading element or leaving `번역 중...` behind.

## Placement Rules

Most paragraphs and long text blocks receive a block translation below the source. Short navigation labels, category labels, tags, and buttons use compact inline placement such as `Guide /가이드`, without reducing the original font size.

Link-heavy prose is translated as a whole when the parent element contains readable direct text. Inline links are marked with temporary `[[LINK_0]]` placeholders before sending to the model so the translated result can preserve links without using unsafe HTML injection.

Reddit-specific guardrails skip narrow long labels and duplicate long text because Reddit often renders the same post title in multiple visible or layout-helper nodes. This avoids vertical, unreadable translations and repeated translated titles.

## Cache Behavior

The translation cache is memory-only. It lives in `background.js` as a `Map` and can hold up to 600 entries.

The cache key includes:

- model
- target language
- custom prompt
- source text

Changing the model, target language, or prompt naturally avoids reusing old cached results. The popup's `메모리 캐시 삭제` button clears the current memory cache so bad model output is not reused during the same background-script lifetime.

The extension does not persist translated page text to `chrome.storage.local`. If a previous development build wrote a legacy `translationCache` key, the current code removes it during install/update and when the memory cache is cleared.

## Privacy

Page text is sent only to the configured local OpenAI-compatible endpoint, normally LM Studio at `http://localhost:1234/v1/chat/completions`. Settings and auto-translate domain choices are stored locally through extension storage. No telemetry, account system, third-party analytics, or remote network calls are added.

## Failure Handling

Long translations keep a runtime port open so MV3 background service workers are less likely to shut down while LM Studio is still responding. If the runtime connection still closes, the content script cancels the active translation, removes loading placeholders, and shows a page status message instead of leaving stale loading UI.

If the model returns invalid JSON or the request times out, the current chunk is reset so the page can be retried.
