const STATE = {
  translated: false,
  translating: false,
  selectionBubble: null,
  settings: null,
  lastUrl: location.href,
  routeTimer: null,
  autoTranslateObserver: null,
  liveTranslateTimer: null,
  selectionRequestId: 0,
  translationRunId: 0,
  nextTranslationId: 1
};

const TERM_PAIR_PATTERN = /\[\[\s*TERM_(\d+)\s*]]([\s\S]*?)\[\[\s*\/\s*TERM_\1\s*]]/gi;
const TERM_MARKER_PATTERN = /\[\[\s*\/?\s*TERM_(?:\d+|N)\s*]]/gi;
const PROTECTED_TERM_PATTERN = /\b(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s)\]]*)?|tinyurl|forum-help|chatgpt|bitly)\b/gi;
const GOOGLE_TITLE_SELECTOR = "h3,.LC20lb,[role='heading']";
const BLOCK_ELEMENT_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "figcaption",
  "dt",
  "dd",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
].join(",");
const TRANSLATION_WIDTHS = new Set(["content", "full"]);
const TRANSLATION_DENSITIES = new Set(["comfortable", "compact"]);
const TITLE_PLACEMENTS = new Set(["auto", "beside", "below"]);
const extensionApi = globalThis.browser || globalThis.chrome;
const USES_PROMISE_API = typeof globalThis.browser !== "undefined";

const TEXT_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "figcaption",
  "dt",
  "dd",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
].join(",");

const SKIP_SELECTOR = [
  "script",
  "style",
  "textarea",
  "input",
  "select",
  "code",
  "pre",
  "kbd",
  "samp",
  "[contenteditable='true']",
  ".llt-translation",
  ".llt-inline-spacer",
  ".llt-selection-bubble",
  ".llt-page-status",
  "[data-llt-skip='1']"
].join(",");

const CHILD_TEXT_SELECTOR = [
  "p",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "[data-testid*='title']",
  "[data-testid*='description']",
  ".VwiC3b",
  ".IsZvec",
  ".MUxGbd",
  "[data-sncf]",
  "a[href]",
  "shreddit-title",
  "[slot='title']",
  "[data-testid='post-title']",
  ".topic-title",
  ".raw-topic-link",
  ".fancy-title"
].join(",");

installRuntimeMessageListener();
init().catch((error) => {
  showPageStatus(getFriendlyTranslationError(error));
});

async function init() {
  const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  if (!settings) return;
  STATE.settings = settings;
  syncExistingTranslationState();

  if (settings.autoTranslate) {
    scheduleAutoTranslate();
  }

  installRouteChangeWatcher();
  installAutoTranslateMutationWatcher();
  exposeDebugApi();
}

function installRuntimeMessageListener() {
  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "TOGGLE_PAGE_TRANSLATION") {
      togglePageTranslation().catch((error) => {
        clearLoadingTranslations();
        STATE.translating = false;
        showPageStatus(getFriendlyTranslationError(error));
      });
    }

    if (message?.type === "SET_SETTINGS") {
      const wasAutoTranslateEnabled = Boolean(STATE.settings?.autoTranslate);
      const previousTargetLanguage = getTargetLanguageCode();
      STATE.settings = { ...STATE.settings, ...(message.settings || {}) };
      const nextTargetLanguage = getTargetLanguageCode();
      if (
        hasExistingTranslations() &&
        previousTargetLanguage &&
        nextTargetLanguage &&
        previousTargetLanguage !== nextTargetLanguage
      ) {
        clearTranslations();
        STATE.translated = false;
      }
      syncExistingTranslationState();
      applySettingsToExistingTranslations();
      if (!STATE.settings.autoTranslate) {
        clearTimeout(STATE.routeTimer);
        STATE.routeTimer = null;
      }
      if (!wasAutoTranslateEnabled && STATE.settings.autoTranslate && !STATE.translated && !STATE.translating) {
        scheduleAutoTranslate(0);
      }
    }

    if (message?.type === "SHOW_SELECTION_TRANSLATION") {
      showSelectionTranslation(message.text || "");
    }
  });
}

async function togglePageTranslation() {
  if (STATE.translating) return;
  syncExistingTranslationState();
  if (STATE.translated) {
    restorePage();
    return;
  }

  await translatePageBlocks({ incremental: false });
}

async function translatePageBlocks({ incremental = false } = {}) {
  if (STATE.translating) return;

  const runId = ++STATE.translationRunId;
  const startUrl = location.href;
  STATE.translating = true;
  showPageStatus(incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중...");
  let activeChunk = [];
  let shouldAutoHideStatus = true;
  const keepAlivePort = openTranslationPort();

  try {
    let initialBlocks = collectTranslatableBlocks();
    if (!initialBlocks.length) {
      if (!incremental) {
        showPageStatus("번역할 텍스트를 찾지 못했습니다.");
      }
      return;
    }

    let completedCount = 0;
    let estimatedTotal = getBlocksElementCount(initialBlocks);
    const maxPasses = 4;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (pass === 0) {
        const topPriorityElements = collectTopPriorityElements();
        estimatedTotal = Math.max(estimatedTotal, completedCount + topPriorityElements.length);

        for (const element of topPriorityElements) {
          if (isStaleTranslationRun(runId, startUrl)) return;
          const text = buildTranslationInput(element).text;
          if (!text) continue;

          insertLoadingTranslation(element);
          activeChunk = [{ elements: [element], text }];

          const response = await sendRuntimeMessage({
            type: "TRANSLATE_TEXTS",
            scope: "page",
            texts: [text]
          }, getMessageTimeoutMs());

          if (isStaleTranslationRun(runId, startUrl)) return;
          if (!response?.ok) {
            throw new Error(response?.error || "번역 실패.");
          }

          finishBilingualTranslation(element, response.translations?.[0] || "");
          completedCount += 1;
          showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
          activeChunk = [];
        }
      }

      const passBlocks = pass === 0 ? initialBlocks : collectTranslatableBlocks();
      const criticalElements = collectCriticalRemainingElements();
      const fallbackBlocks = collectFallbackBlocks();
      const remainingElements = collectRemainingFallbackElements();
      const rescueElements = collectLastResortElements();
      const hasWork =
        passBlocks.length ||
        criticalElements.length ||
        fallbackBlocks.length ||
        remainingElements.length ||
        rescueElements.length;

      if (!hasWork) break;

      estimatedTotal = Math.max(
        estimatedTotal,
        completedCount +
          getBlocksElementCount(passBlocks) +
          criticalElements.length +
          getBlocksElementCount(fallbackBlocks) +
          remainingElements.length +
          rescueElements.length
      );

      for (const chunk of chunkBlocks(passBlocks, getChunkSize(), getMaxBatchChars())) {
        activeChunk = chunk;
        if (isStaleTranslationRun(runId, startUrl)) return;

        chunk.forEach((item) => {
          item.elements.forEach((element) => insertLoadingTranslation(element));
        });

        const texts = chunk.map((item) => item.text);
        const response = await sendRuntimeMessage({
          type: "TRANSLATE_TEXTS",
          scope: "page",
          texts
        }, getMessageTimeoutMs());

        if (isStaleTranslationRun(runId, startUrl)) return;

        if (!response?.ok) {
          throw new Error(response?.error || "번역 실패.");
        }

        response.translations.forEach((translation, index) => {
          chunk[index].elements.forEach((element) => {
            finishBilingualTranslation(element, translation);
          });
        });

        completedCount += getBlocksElementCount(chunk);
        showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
        activeChunk = [];
      }

      for (const element of criticalElements) {
        if (isStaleTranslationRun(runId, startUrl)) return;
        const text = buildTranslationInput(element).text;
        if (!text) continue;

        insertLoadingTranslation(element);
        activeChunk = [{ elements: [element], text }];

        const response = await sendRuntimeMessage({
          type: "TRANSLATE_TEXTS",
          scope: "page",
          texts: [text]
        }, getMessageTimeoutMs());

        if (isStaleTranslationRun(runId, startUrl)) return;
        if (!response?.ok) {
          throw new Error(response?.error || "번역 실패.");
        }

        finishBilingualTranslation(element, response.translations?.[0] || "");
        completedCount += 1;
        showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
        activeChunk = [];
      }

      for (const chunk of chunkBlocks(fallbackBlocks, Math.max(4, Math.floor(getChunkSize() / 2)), getMaxBatchChars())) {
        activeChunk = chunk;
        if (isStaleTranslationRun(runId, startUrl)) return;

        chunk.forEach((item) => {
          item.elements.forEach((element) => insertLoadingTranslation(element));
        });

        const texts = chunk.map((item) => item.text);
        const response = await sendRuntimeMessage({
          type: "TRANSLATE_TEXTS",
          scope: "page",
          texts
        }, getMessageTimeoutMs());

        if (isStaleTranslationRun(runId, startUrl)) return;

        if (!response?.ok) {
          throw new Error(response?.error || "번역 실패.");
        }

        response.translations.forEach((translation, index) => {
          chunk[index].elements.forEach((element) => {
            finishBilingualTranslation(element, translation);
          });
        });

        completedCount += getBlocksElementCount(chunk);
        showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
        activeChunk = [];
      }

      for (const element of remainingElements) {
        if (isStaleTranslationRun(runId, startUrl)) return;
        insertLoadingTranslation(element);
        activeChunk = [{ elements: [element], text: buildTranslationInput(element).text }];

        const response = await sendRuntimeMessage({
          type: "TRANSLATE_TEXTS",
          scope: "page",
          texts: [activeChunk[0].text]
        }, getMessageTimeoutMs());

        if (isStaleTranslationRun(runId, startUrl)) return;
        if (!response?.ok) {
          throw new Error(response?.error || "번역 실패.");
        }

        finishBilingualTranslation(element, response.translations?.[0] || "");
        completedCount += 1;
        showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
        activeChunk = [];
      }

      for (const element of rescueElements) {
        if (isStaleTranslationRun(runId, startUrl)) return;
        const text = buildTranslationInput(element).text;
        if (!text) continue;

        insertLoadingTranslation(element);
        activeChunk = [{ elements: [element], text }];

        const response = await sendRuntimeMessage({
          type: "TRANSLATE_TEXTS",
          scope: "page",
          texts: [text]
        }, getMessageTimeoutMs());

        if (isStaleTranslationRun(runId, startUrl)) return;
        if (!response?.ok) {
          throw new Error(response?.error || "번역 실패.");
        }

        finishBilingualTranslation(element, response.translations?.[0] || "");
        completedCount += 1;
        showPageStatus(`${incremental ? "새 콘텐츠 번역 중..." : "페이지 번역 중..."} ${completedCount}/${estimatedTotal}`);
        activeChunk = [];
      }

      await delay(120);
    }

    STATE.translated = true;
    showPageStatus(incremental ? "새 콘텐츠 번역 완료." : "번역 완료.");
  } catch (error) {
    if (isStaleTranslationRun(runId, startUrl)) return;
    cancelActivePageTranslation();
    resetFailedTranslationChunk(activeChunk);
    if (isRuntimeMessageError(error)) {
      clearLoadingTranslations();
    }
    shouldAutoHideStatus = false;
    showPageStatus(getFriendlyTranslationError(error));
  } finally {
    closeTranslationPort(keepAlivePort);
    if (!isStaleTranslationRun(runId, startUrl)) {
      STATE.translating = false;
      if (shouldAutoHideStatus && (!incremental || activeChunk.length === 0)) {
        setTimeout(removePageStatus, 1600);
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectTranslatableBlocks() {
  const elements = [
    ...collectNavigationLabelElements(),
    ...collectPriorityTextElements(),
    ...collectRootScopedTextElements()
  ];
  const blocksByText = new Map();
  const blocks = [];
  const seenElements = new Set();
  const maxBlocks = getMaxBlocks();
  const maxBlockChars = getMaxBlockChars();
  let elementCount = 0;

  for (const element of elements) {
    if (seenElements.has(element)) continue;
    if (!isGoodCandidate(element)) continue;

    const text = buildTranslationInput(element).text;
    if (!text) continue;
    if (text.length > maxBlockChars) continue;

    if (shouldSkipDuplicateText(text, blocksByText)) continue;

    const existing = blocksByText.get(text);
    if (existing) {
      existing.elements.push(element);
    } else {
      const block = { elements: [element], text };
      blocksByText.set(text, block);
      blocks.push(block);
    }

    seenElements.add(element);
    elementCount += 1;
    if (elementCount >= maxBlocks) break;
  }

  return blocks;
}

function collectRootScopedTextElements() {
  const roots = getContentRoots();
  const elements = [];
  const seen = new Set();

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    for (const element of root.querySelectorAll(TEXT_SELECTOR)) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      elements.push(element);
    }
  }

  return elements;
}

function collectPriorityTextElements() {
  const roots = getContentRoots();
  const elements = [];
  const seen = new Set();
  const selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th";

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    for (const element of root.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      elements.push(element);
    }
  }

  return elements;
}

function collectNavigationLabelElements() {
  const elements = [];
  const seen = new Set();
  const selector = [
    "header a[href]",
    "header button",
    "nav a[href]",
    "nav button",
    "[role='navigation'] a[href]",
    "[role='navigation'] button",
    ".d-header a[href]",
    ".d-header button",
    ".nav-pills a[href]",
    ".nav-pills button",
    ".navigation-container a[href]",
    ".navigation-container button"
  ].join(",");

  for (const root of getNavigationRoots()) {
    if (!(root instanceof HTMLElement)) continue;
    for (const element of root.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      elements.push(element);
    }
  }

  return elements;
}

function collectTopPriorityElements() {
  const roots = getContentRoots();
  const results = [];
  const seen = new Set();
  const selector = "h1,h2,h3,h4,p,li,blockquote";

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    for (const element of root.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (!isGoodFallbackCandidate(element)) continue;
      results.push(element);
      if (results.length >= 12) {
        return results;
      }
    }
  }

  return results;
}

function collectFallbackBlocks() {
  const roots = getContentRoots();
  const fallbackElements = [];
  const seen = new Set();

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    const candidates = root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote");
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (hasLiveTranslationState(element)) continue;
      if (findTranslationElement(element)) continue;
      if (!isGoodFallbackCandidate(element)) continue;
      fallbackElements.push(element);
    }
  }

  const blocksByText = new Map();
  const blocks = [];
  for (const element of fallbackElements) {
    const text = buildTranslationInput(element).text;
    if (!text) continue;
    const existing = blocksByText.get(text);
    if (existing) {
      existing.elements.push(element);
    } else {
      const block = { elements: [element], text };
      blocksByText.set(text, block);
      blocks.push(block);
    }
  }

  return blocks;
}

function collectCriticalRemainingElements() {
  const roots = getContentRoots();
  const results = [];
  const seen = new Set();
  const selector = "h1,h2,h3,h4,p,li,blockquote";

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    for (const element of root.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (hasLiveTranslationState(element)) continue;
      if (findTranslationElement(element)) continue;
      if (!isActuallyVisible(element)) continue;
      if (isRedundantInlineCandidate(element)) continue;
      if (shouldSkipTargetLanguageText(getCandidateText(element))) continue;

      const text = buildTranslationInput(element).text;
      if (!text || text.length > getMaxBlockChars()) continue;
      if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) continue;

      results.push(element);
      if (results.length >= 12) {
        return results;
      }
    }
  }

  return results;
}

function collectRemainingFallbackElements() {
  const roots = getContentRoots();
  const results = [];
  const seen = new Set();

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    const candidates = root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote");
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (hasLiveTranslationState(element)) continue;
      if (findTranslationElement(element)) continue;
      if (!isGoodFallbackCandidate(element)) continue;
      results.push(element);
    }
  }

  return results.slice(0, 40);
}

function collectLastResortElements() {
  const roots = getContentRoots();
  const results = [];
  const seen = new Set();

  for (const root of roots) {
    if (!(root instanceof HTMLElement)) continue;
    const candidates = root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote");
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (hasLiveTranslationState(element)) continue;
      if (findTranslationElement(element)) continue;
      if (element.closest("header, nav, [role='navigation'], .d-header, .navigation-container, .nav-pills, .category-breadcrumb")) {
        continue;
      }
      if (!isActuallyVisible(element)) continue;

      const text = buildTranslationInput(element).text;
      if (!text) continue;
      if (text.length > getMaxBlockChars()) continue;
      if (shouldSkipTargetLanguageText(text)) continue;
      if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) continue;

      results.push(element);
      if (results.length >= 20) {
        return results;
      }
    }
  }

  return results;
}

function getContentRoots() {
  const prioritizedSelectorGroups = [
    "[itemprop='mainContentOfPage'], .cooked",
    "article, main",
    ".body-page, .static-page",
    ".contents"
  ];

  for (const selector of prioritizedSelectorGroups) {
    const roots = Array.from(document.querySelectorAll(selector))
      .filter((element) => element instanceof HTMLElement);
    if (roots.length) {
      return roots;
    }
  }

  return [document.body].filter(Boolean);
}

function getNavigationRoots() {
  const roots = Array.from(document.querySelectorAll(
    "header, nav, [role='navigation'], .d-header, .navigation-container, .nav-pills"
  )).filter((element) => element instanceof HTMLElement);

  return roots.length ? roots : [document.body].filter(Boolean);
}

function getBlocksElementCount(blocks) {
  return blocks.reduce((count, block) => count + block.elements.length, 0);
}

function isGoodCandidate(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  if (hasLiveTranslationState(element)) return false;
  if (
    element.closest("header, nav, [role='navigation'], .d-header, .navigation-container, .nav-pills, .category-breadcrumb") &&
    !isNavigationLikeElement(element)
  ) {
    return false;
  }
  if (isGoogleTitleOuterLink(element)) return false;
  if (isRedundantInlineCandidate(element)) return false;
  if (isContainerWithOwnReadableChildren(element)) return false;
  if (isCompactLabelContainerWithChild(element)) return false;
  if (!isActuallyVisible(element)) return false;

  const text = getCandidateText(element);
  if (shouldSkipLanguageLabel(text, element)) return false;
  if (text.length < 8 && !shouldUseCompactLabelTranslation(element)) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) return false;
  if (shouldSkipTargetLanguageText(text)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 8) return false;
  if (isNarrowLongLabel(element, text, rect)) return false;

  return true;
}

function isGoodFallbackCandidate(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  if (hasLiveTranslationState(element)) return false;
  if (
    element.closest("header, nav, [role='navigation'], .d-header, .navigation-container, .nav-pills, .category-breadcrumb") &&
    !isNavigationLikeElement(element)
  ) {
    return false;
  }
  if (!isActuallyVisible(element)) return false;
  if (isRedundantInlineCandidate(element)) return false;
  if (isContainerWithOwnReadableChildren(element)) return false;

  const text = getCandidateText(element);
  if (!text) return false;
  if (text.length > getMaxBlockChars()) return false;
  if (shouldSkipLanguageLabel(text, element)) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) return false;
  if (shouldSkipTargetLanguageText(text)) return false;

  if (isHeadingElement(element)) return text.length >= 3;
  return text.length >= 12;
}

function hasLiveTranslationState(element) {
  if (!(element instanceof HTMLElement)) return false;
  const hasMarker = element.dataset.lltTranslated === "1";
  if (!hasMarker) return false;
  const translationElement = findTranslationElement(element);
  if (translationElement) return true;

  element.removeAttribute("data-lltTranslated");
  element.removeAttribute("data-llt-translated");
  element.removeAttribute("data-llt-original-display");
  element.removeAttribute("data-llt-translation-id");
  return false;
}

function shouldSkipLanguageLabel(text, element) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;

  const labelMap = {
    ko: ["ko", "kor", "korean", "한국어", "한글"],
    en: ["en", "eng", "english", "영어"],
    ja: ["ja", "jp", "jpn", "japanese", "일본어"],
    zh: ["zh", "cn", "chi", "zho", "chinese", "중국어", "中文"],
    es: ["es", "spa", "spanish", "espanol", "español", "스페인어"]
  };

  const target = getTargetLanguageCode();
  const targetLabels = target ? (labelMap[target] || []) : [];
  if (targetLabels.includes(normalized)) {
    return true;
  }

  if (normalized.length <= 3 && element.closest("[aria-label*='language' i], [title*='language' i], [lang]")) {
    return true;
  }

  return false;
}

function isActuallyVisible(element) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (Number(style.opacity) === 0) return false;
  if (element.closest("noscript, template, [hidden], .hidden")) return false;
  return true;
}

function shouldSkipTargetLanguageText(text) {
  const target = getTargetLanguageCode();
  if (!target) return false;

  const detected = detectLanguageFromText(text);
  return detected === target;
}

function insertBilingualTranslation(element, translation) {
  if (!translation || element.dataset.lltTranslated === "1") return;

  const translationElement = createTranslationElement();
  bindTranslationElement(element, translationElement);

  element.dataset.lltTranslated = "1";
  element.dataset.lltOriginalDisplay = element.style.display || "";

  placeTranslationElement(element, translationElement);
  renderTranslationContent(translationElement, translation, element);
}

function insertLoadingTranslation(element) {
  if (element.dataset.lltTranslated === "1") return;

  const translationElement = createTranslationElement({ loading: true });
  bindTranslationElement(element, translationElement);

  element.dataset.lltTranslated = "1";
  element.dataset.lltOriginalDisplay = element.style.display || "";

  placeTranslationElement(element, translationElement);
}

function createTranslationElement(options = {}) {
  const translationElement = document.createElement("span");
  translationElement.className = options.loading ? "llt-translation llt-loading" : "llt-translation";
  translationElement.dataset.lltSkip = "1";
  translationElement.dir = "auto";
  applyTranslationDisplaySettings(translationElement);

  const lang = inferTargetLanguageCode();
  if (lang) translationElement.lang = lang;
  translationElement.dataset.lltTargetLanguage = lang || String(STATE.settings?.targetLanguage || "").trim().toLowerCase();

  if (options.loading) {
    const spinner = document.createElement("span");
    spinner.className = "llt-spinner";
    spinner.setAttribute("aria-hidden", "true");
    translationElement.setAttribute("aria-label", "번역 중");
    translationElement.append(spinner);
  }

  return translationElement;
}

function bindTranslationElement(sourceElement, translationElement) {
  const id = sourceElement.dataset.lltTranslationId || String(STATE.nextTranslationId++);
  sourceElement.dataset.lltTranslationId = id;
  translationElement.dataset.lltSourceId = id;
}

function placeTranslationElement(element, translationElement) {
  const placement = getTranslationPlacement(element);
  translationElement.dataset.lltPlacement = placement.mode;

  if (placement.mode === "after-element") {
    translationElement.classList.add("llt-block", "llt-link-translation");
    placement.target.insertAdjacentElement("afterend", translationElement);
  } else if (placement.mode === "after-link") {
    translationElement.classList.add("llt-block", "llt-link-translation");
    placement.target.insertAdjacentElement("afterend", translationElement);
  } else if (placement.mode === "google-title-after-link") {
    translationElement.classList.add("llt-block", "llt-link-translation", "llt-google-title");
    placement.target.insertAdjacentElement("afterend", translationElement);
  } else if (placement.mode === "inside-google-title-link") {
    translationElement.classList.add("llt-block", "llt-google-title", "llt-clickable-by-parent");
    placement.target.appendChild(translationElement);
  } else if (placement.mode === "compact-label") {
    translationElement.classList.add("llt-inline", "llt-compact-label");
    if (placement.target.closest("a[href]")) {
      translationElement.classList.add("llt-clickable-by-parent");
    }
    appendCompactLabelTranslation(placement.target, translationElement);
  } else if (placement.mode === "title-inline") {
    translationElement.classList.add("llt-inline", "llt-title-inline");
    if (placement.target.closest("a[href]")) {
      translationElement.classList.add("llt-clickable-by-parent");
    }
    appendInlineTranslation(placement.target, translationElement);
  } else if (isInlineElement(element)) {
    translationElement.classList.add("llt-inline");
    appendInlineTranslation(element, translationElement);
  } else {
    translationElement.classList.add("llt-block");
    element.insertAdjacentElement("afterend", translationElement);
  }
}

function appendInlineTranslation(target, translationElement) {
  const spacer = document.createElement("span");
  spacer.className = "llt-inline-spacer";
  spacer.dataset.lltSkip = "1";
  spacer.textContent = " ";
  target.append(spacer, translationElement);
}

function appendCompactLabelTranslation(target, translationElement) {
  const separator = document.createElement("span");
  separator.className = "llt-inline-spacer llt-compact-separator";
  separator.dataset.lltSkip = "1";
  separator.textContent = "/";
  target.append(separator, translationElement);
}

function finishBilingualTranslation(element, translation) {
  const translationElement = findTranslationElement(element);
  if (!translationElement) {
    insertBilingualTranslation(element, translation);
    return;
  }

  translationElement.classList.remove("llt-loading");
  renderTranslationContent(translationElement, translation || "번역 실패.", element);
}

function resetFailedTranslationChunk(chunk) {
  chunk.forEach((item) => {
    item.elements.forEach((element) => {
      const translationElement = findTranslationElement(element);
      if (translationElement?.classList.contains("llt-loading")) {
        translationElement.remove();
      }

      const spacer = element.lastElementChild;
      if (spacer?.classList.contains("llt-inline-spacer")) {
        spacer.remove();
      }

      element.removeAttribute("data-llt-translated");
      element.removeAttribute("data-llt-original-display");
      element.removeAttribute("data-llt-translation-id");
    });
  });
}

function findTranslationElement(element) {
  const sourceId = element.dataset.lltTranslationId;
  if (sourceId) {
    const exactMatch = Array.from(document.querySelectorAll(".llt-translation"))
      .find((translationElement) => translationElement.dataset.lltSourceId === sourceId);
    if (exactMatch) return exactMatch;
  }

  const placement = getTranslationPlacement(element);

  if (
    placement.mode === "after-element" ||
    placement.mode === "after-link" ||
    placement.mode === "google-title-after-link"
  ) {
    const next = placement.target.nextElementSibling;
    return next?.classList.contains("llt-translation") ? next : null;
  }

  if (
    placement.mode === "title-inline" ||
    placement.mode === "compact-label" ||
    placement.mode === "inside-google-title-link" ||
    isInlineElement(element)
  ) {
    const children = Array.from(element.children);
    return children.find((child) => child.classList.contains("llt-translation"));
  }

  const next = element.nextElementSibling;
  return next?.classList.contains("llt-translation") ? next : null;
}

function restorePage() {
  clearTranslations();
  STATE.translated = false;
  showPageStatus("원문으로 복원했습니다.");
  setTimeout(removePageStatus, 1200);
}

function clearTranslations() {
  document.querySelectorAll(".llt-translation").forEach((element) => element.remove());
  document.querySelectorAll(".llt-inline-spacer").forEach((element) => element.remove());
  document.querySelectorAll("[data-llt-translated='1']").forEach((element) => {
    element.removeAttribute("data-llt-translated");
    element.removeAttribute("data-llt-original-display");
    element.removeAttribute("data-llt-translation-id");
  });
}

function clearLoadingTranslations() {
  document.querySelectorAll(".llt-translation.llt-loading").forEach((element) => element.remove());
  document.querySelectorAll(".llt-inline-spacer").forEach((element) => {
    if (!element.nextElementSibling) {
      element.remove();
    }
  });
  document.querySelectorAll("[data-llt-translated='1']").forEach((element) => {
    if (!findTranslationElement(element)) {
      element.removeAttribute("data-llt-translated");
      element.removeAttribute("data-llt-original-display");
      element.removeAttribute("data-llt-translation-id");
    }
  });
}

function hasExistingTranslations() {
  return document.querySelector(".llt-translation") instanceof HTMLElement;
}

function getExistingTranslationLanguage() {
  const translationElement = document.querySelector(".llt-translation:not(.llt-loading)");
  if (!(translationElement instanceof HTMLElement)) return "";
  return String(
    translationElement.dataset.lltTargetLanguage ||
    translationElement.getAttribute("lang") ||
    ""
  )
    .trim()
    .toLowerCase();
}

function syncExistingTranslationState() {
  const loadingCount = document.querySelectorAll(".llt-translation.llt-loading").length;
  const translationCount = document.querySelectorAll(".llt-translation:not(.llt-loading)").length;

  if (!loadingCount && !translationCount) {
    STATE.translated = false;
    return;
  }

  if (loadingCount && !translationCount) {
    clearLoadingTranslations();
    STATE.translated = false;
    return;
  }

  const targetLanguage = getTargetLanguageCode();
  const existingLanguage = getExistingTranslationLanguage();
  if (targetLanguage && existingLanguage && targetLanguage !== existingLanguage) {
    clearTranslations();
    STATE.translated = false;
    return;
  }

  STATE.translated = true;
}

function showSelectionTranslation(text) {
  const normalized = normalizeText(text);
  if (!normalized) return;

  const requestId = ++STATE.selectionRequestId;
  const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
  const anchor = range ? { getBoundingClientRect: () => range.getBoundingClientRect() } : document.body;
  showSelectionBubble(anchor, "번역 중...");

  sendRuntimeMessage({ type: "TRANSLATE_TEXTS", scope: "selection", texts: [normalized] }, getMessageTimeoutMs())
    .then((response) => {
      if (requestId !== STATE.selectionRequestId) return;
      if (!response?.ok) throw new Error(response?.error || "선택 영역 번역 실패.");
      showSelectionBubble(anchor, response.translations[0] || "");
    })
    .catch((error) => {
      if (requestId !== STATE.selectionRequestId) return;
      showSelectionBubble(anchor, error.message || "번역 실패.");
    });
}

function sendRuntimeMessage(message, timeoutMs = 125000) {
  return new Promise((resolve, reject) => {
    if (!extensionApi?.runtime?.id) {
      reject(new Error("확장 프로그램이 다시 로드되었습니다. 확장 프로그램을 새로고침한 뒤 이 페이지도 새로고침하세요."));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error("확장 메시지 시간이 초과되었습니다. LM Studio가 아직 생성 중일 수 있습니다."));
    }, timeoutMs);

    sendExtensionMessage(message)
      .then((response) => {
        clearTimeout(timeout);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function sendExtensionMessage(message) {
  if (USES_PROMISE_API) {
    return extensionApi.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function openTranslationPort() {
  try {
    return extensionApi.runtime.connect({ name: "llt-translation" });
  } catch {
    return null;
  }
}

function closeTranslationPort(port) {
  try {
    port?.disconnect();
  } catch {
    // The port may already be closed if the extension was reloaded mid-translation.
  }
}

function getMessageTimeoutMs() {
  return Number(STATE.settings?.requestTimeoutMs || 120000) + 5000;
}

function getFriendlyTranslationError(error) {
  const message = String(error?.message || "");
  if (isRuntimeMessageError(error)) {
    return "번역 연결이 끊겼습니다. 확장을 새로고침했다면 이 페이지도 새로고침한 뒤 다시 시도하세요.";
  }

  return message || "번역 실패.";
}

function isRuntimeMessageError(error) {
  return /message channel closed|Extension context invalidated|Receiving end does not exist|확장 프로그램이 다시 로드/i.test(String(error?.message || ""));
}

function showSelectionBubble(anchor, text) {
  if (!STATE.selectionBubble) {
    STATE.selectionBubble = document.createElement("div");
    STATE.selectionBubble.className = "llt-selection-bubble";
    STATE.selectionBubble.dataset.lltSkip = "1";
    document.documentElement.appendChild(STATE.selectionBubble);
  }

  STATE.selectionBubble.replaceChildren();
  const closeButton = document.createElement("button");
  closeButton.className = "llt-selection-close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => hideSelectionBubble());

  const body = document.createElement("div");
  body.className = "llt-selection-body";
  body.textContent = cleanupLinkMarkers(text);

  STATE.selectionBubble.append(closeButton, body);
  STATE.selectionBubble.style.display = "block";

  const rect = anchor.getBoundingClientRect();
  const top = Math.max(12, window.scrollY + rect.bottom + 8);
  const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 360);

  STATE.selectionBubble.style.top = `${top}px`;
  STATE.selectionBubble.style.left = `${Math.max(12, left)}px`;
}

function hideSelectionBubble() {
  STATE.selectionRequestId += 1;
  if (STATE.selectionBubble) STATE.selectionBubble.style.display = "none";
}

function showPageStatus(text) {
  let status = document.querySelector(".llt-page-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "llt-page-status";
    status.dataset.lltSkip = "1";
    document.documentElement.appendChild(status);
  }
  status.textContent = text;
}

function removePageStatus() {
  document.querySelector(".llt-page-status")?.remove();
}

function isInlineElement(element) {
  return ["SPAN", "STRONG", "EM", "B", "I"].includes(element.tagName);
}

function isLinkElement(element) {
  return element.tagName === "A";
}

function isRedundantInlineCandidate(element) {
  if (!(isLinkElement(element) || element.tagName === "BUTTON" || element.getAttribute("role") === "button")) {
    return false;
  }

  if (isGoogleSearchPage()) return false;
  if (element.closest("nav, header, [role='navigation'], .d-header, .category-breadcrumb, .navigation-container, .nav-pills")) {
    return false;
  }

  const parentBlock = element.parentElement?.closest([
    BLOCK_ELEMENT_SELECTOR,
    ".cooked",
    "[itemprop='mainContentOfPage']"
  ].join(","));

  if (!parentBlock || parentBlock === element) {
    return false;
  }

  if (element.matches(".anchor, .hashtag-cooked, .mention")) {
    return true;
  }

  const parentText = extractElementText(parentBlock);
  const ownText = extractElementText(element);
  if (!ownText || !parentText) return false;

  const normalizedParentText = normalizeText(parentText);
  const normalizedOwnText = normalizeText(ownText);
  if (!normalizedOwnText || !normalizedParentText) return false;

  if (isHeadingElement(parentBlock) && parentBlock !== element) {
    return true;
  }

  if (normalizedParentText === normalizedOwnText) {
    return true;
  }

  if (normalizedParentText.includes(normalizedOwnText)) {
    return true;
  }

  return normalizedParentText.length >= normalizedOwnText.length;
}

function getTranslationPlacement(element) {
  if (isGoogleSearchResultTitle(element)) {
    if (shouldPlaceTitleBeside(element)) {
      return { mode: "title-inline", target: element };
    }
    return { mode: "inside-google-title-link", target: element };
  }

  if (isHeadingElement(element) && shouldPlaceTitleBeside(element)) {
    return { mode: "title-inline", target: element };
  }

  if (shouldUseCompactLabelTranslation(element)) {
    return { mode: "compact-label", target: element };
  }

  if (shouldKeepTranslationBesideSourceElement(element)) {
    return { mode: "after-element", target: element };
  }

  if (isLinkElement(element)) {
    return { mode: "after-link", target: element };
  }

  const closestLink = element.closest("a[href]");
  if (closestLink && closestLink.contains(element)) {
    return { mode: "after-link", target: closestLink };
  }

  return { mode: "default", target: element };
}

function shouldKeepTranslationBesideSourceElement(element) {
  if (!isGoogleSearchPage()) return false;
  if (!element.closest("a[href]")) return false;

  return element.matches("h1,h2,h3,h4,.VwiC3b,.IsZvec,.MUxGbd,[data-sncf]");
}

function isGoogleSearchPage() {
  return /(^|\.)google\./i.test(location.hostname) && location.pathname === "/search";
}

function isGoogleSearchResultTitle(element) {
  if (!isGoogleSearchPage()) return false;
  if (!element.matches(GOOGLE_TITLE_SELECTOR)) return false;
  if (!element.closest("#search, [role='main']")) return false;

  return Boolean(element.closest("a[href]"));
}

function isGoogleTitleOuterLink(element) {
  if (!isGoogleSearchPage() || !isLinkElement(element)) return false;
  return Boolean(element.querySelector(GOOGLE_TITLE_SELECTOR));
}

function isHeadingElement(element) {
  return ["H1", "H2", "H3", "H4"].includes(element.tagName) || element.matches(".LC20lb,[role='heading']");
}

function shouldPlaceTitleBeside(element) {
  const mode = normalizeSettingChoice("titlePlacement", TITLE_PLACEMENTS, "auto");
  if (mode === "beside") return true;
  if (mode === "below") return false;
  if (isGoogleSearchResultTitle(element)) return true;

  const text = extractElementText(element);
  const normalizedText = normalizeText(text);
  const wordCount = normalizedText ? normalizedText.split(/\s+/).length : 0;

  if (isHeadingElement(element)) {
    return false;
  }

  if (!isHeadingElement(element)) {
    if (text.length <= 28) return true;
    if (text.length > 42) return false;
  }

  const rect = element.getBoundingClientRect();
  return !rect.width || rect.width < Math.min(window.innerWidth * 0.55, 520);
}

function shouldUseCompactLabelTranslation(element) {
  if (!isNavigationLikeElement(element)) return false;

  const text = extractElementText(element);
  if (!isShortLabelText(text)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width > 260 || rect.height > 96) return false;

  return true;
}

function isCompactLabelContainerWithChild(element) {
  if (!isNavigationLikeElement(element)) return false;
  if (isLinkElement(element) || element.tagName === "BUTTON") return false;

  return Array.from(element.children).some((child) => (
    child instanceof HTMLElement &&
    (isLinkElement(child) || child.tagName === "BUTTON") &&
    isShortLabelText(extractElementText(child))
  ));
}

function isNavigationLikeElement(element) {
  if (element.closest("nav, header, [role='navigation'], .d-header, .category-breadcrumb, .navigation-container, .nav-pills")) {
    return true;
  }

  if (element.tagName === "BUTTON") return true;

  if (element.matches(".badge-wrapper, .badge-category, .discourse-tag, [class*='category'], [class*='tag']")) {
    return true;
  }

  return Boolean(element.closest(".badge-wrapper, .badge-category, .discourse-tag, [class*='category'], [class*='tag']"));
}

function isNarrowLongLabel(element, text, rect) {
  if (!isRedditPage()) return false;
  if (shouldUseCompactLabelTranslation(element)) return false;
  return rect.width < 180 && normalizeText(text).length > 28;
}

function shouldSkipDuplicateText(text, blocksByText) {
  if (!isRedditPage()) return false;
  return normalizeText(text).length > 24 && blocksByText.has(text);
}

function isRedditPage() {
  return /(^|\.)reddit\.com$/i.test(location.hostname);
}

function isShortLabelText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.length > 28) return false;
  if (/[.!?。！？]/.test(normalized)) return false;
  if (normalized.split(/\s+/).length > 4) return false;

  return /[\p{L}\p{N}]/u.test(normalized);
}

function isContainerWithOwnReadableChildren(element) {
  if (!["LI", "TD", "TH", "DIV", "SECTION", "ARTICLE", "MAIN"].includes(element.tagName)) return false;
  if (hasReadableDirectText(element)) return false;

  return Array.from(element.querySelectorAll(CHILD_TEXT_SELECTOR)).some((child) => {
    if (child === element || child.closest(SKIP_SELECTOR)) return false;
    const text = extractElementText(child);
    return text.length >= 8 && !/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text);
  });
}

function hasReadableDirectText(element) {
  const directText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ");
  const text = normalizeText(directText);
  return text.length >= 8 && !/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text);
}

function buildTranslationInput(element) {
  return { text: getCandidateText(element), links: [] };
}

function hasProtectedPlaceholders(text) {
  return false;
}

function renderTranslationContent(container, translation, sourceElement) {
  container.replaceChildren();
  const normalizedTranslation = normalizeLinkMarkerSyntax(translation);

  if (container.closest("a[href]")) {
    container.textContent = cleanupLinkMarkers(normalizedTranslation);
    return;
  }

  renderPlainMarkedText(container, normalizedTranslation);
}

function getElementLinks(element) {
  const closestLink = element.closest("a[href]");
  const candidates = isLinkElement(element)
    ? [element]
    : closestLink?.contains(element)
      ? [closestLink]
      : Array.from(element.querySelectorAll("a[href]"));

  return candidates
    .filter((anchor) => !shouldIgnoreTranslationLink(anchor, element))
    .map((anchor) => ({
      href: anchor.href,
      target: anchor.target,
      rel: anchor.rel,
      text: getLinkText(anchor, element)
    }))
    .filter((link) => link.href && link.text);
}

function getLinkText(anchor, sourceElement) {
  if (anchor.contains(sourceElement) && anchor !== sourceElement) {
    return getCandidateText(sourceElement);
  }
  return extractElementText(anchor);
}

function shouldIgnoreTranslationLink(anchor, sourceElement) {
  if (!(anchor instanceof HTMLAnchorElement)) return true;
  if (!(sourceElement instanceof HTMLElement)) return false;

  if (isHeadingElement(sourceElement)) {
    if (isIgnoredHeadingLink(anchor)) return true;

    try {
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.hash) {
        return true;
      }
    } catch {
      // Ignore URL parsing failures and preserve the link.
    }
  }

  return false;
}

function getCandidateText(element) {
  if (isHeadingElement(element)) {
    const headingText = extractHeadingText(element);
    if (headingText) return headingText;
  }
  return extractElementText(element);
}

function extractHeadingText(element) {
  const ownText = extractElementText(element);
  const headingLinks = Array.from(element.querySelectorAll("a[href]"))
    .filter((link) => !isIgnoredHeadingLink(link))
    .map((link) => normalizeText(link.innerText || link.textContent || ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  if (headingLinks.length) {
    const bestLinkText = headingLinks[0];
    if (!ownText || ownText === bestLinkText || ownText.includes(bestLinkText)) {
      return bestLinkText;
    }
  }

  return ownText;
}

function isIgnoredHeadingLink(link) {
  if (!(link instanceof HTMLElement)) return true;
  const ariaLabel = String(link.getAttribute("aria-label") || "").trim().toLowerCase();
  if (ariaLabel === "heading link") return true;
  if (link.matches(".anchor")) return true;
  return false;
}

function getDominantLink(links) {
  return links.length === 1 ? links[0] : null;
}

function shouldUseWholeTranslationLinkFallback(sourceElement) {
  if (!(sourceElement instanceof HTMLElement)) return false;
  if (isLinkElement(sourceElement)) return true;

  const text = getCandidateText(sourceElement);
  if (!isShortLabelText(text)) return false;

  if (isHeadingElement(sourceElement)) return true;
  if (sourceElement.tagName === "BUTTON") return true;
  if (sourceElement.matches("[role='button'], .topic-title, .fancy-title, .raw-topic-link, a.title")) return true;

  return false;
}

function appendText(container, text) {
  if (text) container.appendChild(document.createTextNode(text));
}

function cleanupLinkMarkers(text) {
  return normalizeLinkMarkerSyntax(text)
    .replace(TERM_MARKER_PATTERN, "");
}

function normalizeLinkMarkerSyntax(text) {
  return String(text || "")
    .replace(/\[\[\s*TERM_(\d+)\s*]]/gi, (_, index) => `[[TERM_${index}]]`)
    .replace(/\[\[\s*\/\s*TERM_(\d+)\s*]]/gi, (_, index) => `[[/TERM_${index}]]`);
}

function renderPlainMarkedText(container, text) {
  const normalized = normalizeLinkMarkerSyntax(text);
  let cursor = 0;
  let match;
  let rendered = false;

  TERM_PAIR_PATTERN.lastIndex = 0;
  while ((match = TERM_PAIR_PATTERN.exec(normalized)) !== null) {
    rendered = true;
    appendText(container, cleanupLinkMarkers(normalized.slice(cursor, match.index)));
    appendText(container, cleanupLinkMarkers(match[2]));
    cursor = TERM_PAIR_PATTERN.lastIndex;
  }

  if (!rendered) {
    appendText(container, cleanupLinkMarkers(normalized));
    return;
  }

  appendText(container, cleanupLinkMarkers(normalized.slice(cursor)));
}

function protectLiteralTerms(text) {
  let nextIndex = 0;
  return String(text || "").replace(PROTECTED_TERM_PATTERN, (match) => {
    const normalized = normalizeText(match);
    if (!normalized) return match;
    return `[[TERM_${nextIndex++}]]${match}[[/TERM_${nextIndex - 1}]]`;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractElementText(element) {
  if (!(element instanceof HTMLElement)) return "";

  const parts = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (shouldIgnoreTextParent(parent)) return NodeFilter.FILTER_REJECT;
      const text = normalizeText(node.textContent || "");
      return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  let current;
  while ((current = walker.nextNode())) {
    parts.push(current.textContent || "");
  }

  return normalizeText(parts.join(" "));
}

function shouldIgnoreTextParent(element) {
  if (!(element instanceof HTMLElement)) return true;
  if (element.closest(SKIP_SELECTOR)) return true;
  if (element.closest(".anchor, .hashtag-icon-placeholder, svg, img, [aria-hidden='true'], .sr-only, .visually-hidden")) {
    return true;
  }

  const label = String(element.getAttribute("aria-label") || "").trim().toLowerCase();
  if (label === "heading link") return true;

  return false;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferTargetLanguageCode() {
  return getTargetLanguageCode();
}

function getTargetLanguageCode() {
  const target = String(STATE.settings?.targetLanguage || "").trim().toLowerCase();
  if (["ko", "en", "ja", "zh", "es"].includes(target)) return target;
  if (/^(kor|korean|한국어|한글)$/.test(target)) return "ko";
  if (/^(eng|english|영어)$/.test(target)) return "en";
  if (/^(jpn|japanese|일본어)$/.test(target)) return "ja";
  if (/^(zho|chi|chinese|중국어)$/.test(target)) return "zh";
  if (/^(spa|spanish|español|스페인어)$/.test(target)) return "es";
  return "";
}

function detectLanguageFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  if (/[가-힣]/.test(normalized)) return "ko";
  if (/[\u3040-\u30ff]/.test(normalized)) return "ja";
  if (/[\u4e00-\u9fff]/.test(normalized)) return "zh";

  const latinWords = normalized.match(/[A-Za-zÀ-ÿ]+/g) || [];
  if (!latinWords.length) return "";

  const sample = normalized.toLowerCase();
  const spanishHints = countMatches(sample, /\b(el|la|los|las|de|del|para|como|que|por|una|un|y|en)\b/g)
    + countMatches(sample, /[áéíóúñ¿¡]/g);
  const englishHints = countMatches(sample, /\b(the|and|with|that|this|from|you|your|for|page|guide|memory|forum)\b/g);

  if (spanishHints >= englishHints + 2) return "es";
  if (englishHints > 0) return "en";
  return "";
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function applyTranslationDisplaySettings(element) {
  const color = getTranslationColor();
  element.style.setProperty("--llt-accent", color);
  element.style.setProperty("--llt-offset-x", `${getNumberSetting("translationOffsetX", 0, -80, 80)}px`);
  element.style.setProperty("--llt-offset-y", `${getNumberSetting("translationOffsetY", 0, -80, 80)}px`);
  element.dataset.lltDensity = normalizeSettingChoice("translationDensity", TRANSLATION_DENSITIES, "comfortable");
  element.dataset.lltWidth = normalizeSettingChoice("translationWidth", TRANSLATION_WIDTHS, "content");
}

function applySettingsToExistingTranslations() {
  document.querySelectorAll(".llt-translation").forEach((element) => {
    applyTranslationDisplaySettings(element);
  });
}

function getTranslationColor() {
  const color = String(STATE.settings?.translationColor || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#0f766e";
}

function normalizeSettingChoice(key, allowed, fallback) {
  const value = STATE.settings?.[key];
  return allowed.has(value) ? value : fallback;
}

function getChunkSize() {
  return Math.round(getNumberSetting("chunkSize", 24, 1, 24));
}

function getMaxBlocks() {
  return Math.round(getNumberSetting("maxBlocks", 160, 20, 400));
}

function getMaxBlockChars() {
  return Math.round(getNumberSetting("maxBlockChars", 1600, 240, 4000));
}

function getMaxBatchChars() {
  return Math.round(getNumberSetting("maxBatchChars", 5000, 300, 12000));
}

function getNumberSetting(key, fallback, min, max) {
  const value = Number(STATE.settings?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function chunkBlocks(items, maxItems, maxChars) {
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    if (hasProtectedPlaceholders(item.text)) {
      if (current.length) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      chunks.push([item]);
      continue;
    }

    if (current.length && (current.length >= maxItems || currentChars + itemChars > maxChars)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function installRouteChangeWatcher() {
  const notify = () => {
    window.dispatchEvent(new Event("llt-route-change"));
  };

  for (const methodName of ["pushState", "replaceState"]) {
    const original = history[methodName];
    history[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }

  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  window.addEventListener("pageshow", () => {
    if (STATE.settings?.autoTranslate && !STATE.translated && !STATE.translating) {
      scheduleAutoTranslate(0);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && STATE.settings?.autoTranslate && !STATE.translated && !STATE.translating) {
      scheduleAutoTranslate(0);
    }
  });
  window.addEventListener("llt-route-change", handleRouteChange);

  setInterval(() => {
    if (location.href !== STATE.lastUrl) handleRouteChange();
  }, 1000);
}

function installAutoTranslateMutationWatcher() {
  if (STATE.autoTranslateObserver || !document.documentElement) return;

  STATE.autoTranslateObserver = new MutationObserver(() => {
    if (STATE.routeTimer) return;
    if (STATE.translated) {
      scheduleLiveTranslate();
      return;
    }
    if (!STATE.settings?.autoTranslate || STATE.translating) return;
    scheduleAutoTranslate(0);
  });

  STATE.autoTranslateObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function handleRouteChange() {
  if (location.href === STATE.lastUrl) return;

  STATE.translationRunId += 1;
  cancelActivePageTranslation();
  STATE.lastUrl = location.href;
  STATE.translated = false;
  STATE.translating = false;
  clearTranslations();
  hideSelectionBubble();
  removePageStatus();
  clearTimeout(STATE.routeTimer);
  clearTimeout(STATE.liveTranslateTimer);
  STATE.liveTranslateTimer = null;

  if (STATE.settings?.autoTranslate) {
    STATE.routeTimer = setTimeout(() => scheduleAutoTranslate(0), 900);
  }
}

function scheduleLiveTranslate() {
  if (STATE.liveTranslateTimer) {
    clearTimeout(STATE.liveTranslateTimer);
  }

  STATE.liveTranslateTimer = setTimeout(() => {
    STATE.liveTranslateTimer = null;
    if (!STATE.translated || STATE.translating) return;
    if (!collectTranslatableBlocks().length) return;
    translatePageBlocks({ incremental: true }).catch((error) => {
      showPageStatus(getFriendlyTranslationError(error));
    });
  }, 350);
}

function scheduleAutoTranslate(attempt = 0) {
  const scheduledUrl = location.href;
  clearTimeout(STATE.routeTimer);
  STATE.routeTimer = setTimeout(() => {
    STATE.routeTimer = null;
    if (location.href !== scheduledUrl) return;
    if (!STATE.settings?.autoTranslate) return;
    if (STATE.translated || STATE.translating) return;

    if (!collectTranslatableBlocks().length && attempt < 12) {
      scheduleAutoTranslate(attempt + 1);
      return;
    }

    togglePageTranslation();
  }, attempt === 0 ? 500 : 800);
}

function isStaleTranslationRun(runId, startUrl) {
  return runId !== STATE.translationRunId || location.href !== startUrl;
}

function cancelActivePageTranslation() {
  if (!extensionApi?.runtime?.id) return;

  sendExtensionMessage({ type: "CANCEL_TRANSLATION", scope: "page" }).catch(() => {});
}

function exposeDebugApi() {
  const api = {
    get state() {
      return {
        translated: STATE.translated,
        translating: STATE.translating,
        lastUrl: STATE.lastUrl,
        settings: { ...STATE.settings }
      };
    },
    toggle() {
      return togglePageTranslation();
    },
    translate() {
      if (STATE.translated) {
        restorePage();
      }
      return translatePageBlocks({ incremental: false });
    },
    restore() {
      restorePage();
    },
    setSettings(nextSettings = {}) {
      STATE.settings = { ...STATE.settings, ...nextSettings };
      applySettingsToExistingTranslations();
      return { ...STATE.settings };
    },
    collect() {
      return {
        blocks: collectTranslatableBlocks().map((item) => ({
          text: item.text,
          count: item.elements.length,
          tags: item.elements.map((element) => element.tagName)
        })),
        fallbackBlocks: collectFallbackBlocks().map((item) => ({
          text: item.text,
          count: item.elements.length,
          tags: item.elements.map((element) => element.tagName)
        })),
        remaining: collectRemainingFallbackElements().map((element) => ({
          tag: element.tagName,
          text: buildTranslationInput(element).text
        }))
      };
    },
    dump(limit = 20) {
      const data = this.collect();
      const lines = [];
      lines.push(`[blocks] ${data.blocks.length}`);
      data.blocks.slice(0, limit).forEach((item, index) => {
        lines.push(`${index + 1}. ${item.tags.join(",")} :: ${item.text}`);
      });
      lines.push("");
      lines.push(`[fallbackBlocks] ${data.fallbackBlocks.length}`);
      data.fallbackBlocks.slice(0, limit).forEach((item, index) => {
        lines.push(`${index + 1}. ${item.tags.join(",")} :: ${item.text}`);
      });
      lines.push("");
      lines.push(`[remaining] ${data.remaining.length}`);
      data.remaining.slice(0, limit).forEach((item, index) => {
        lines.push(`${index + 1}. ${item.tag} :: ${item.text}`);
      });

      let panel = document.querySelector("#llt-debug-dump");
      if (!panel) {
        panel = document.createElement("pre");
        panel.id = "llt-debug-dump";
        panel.dataset.lltSkip = "1";
        panel.style.position = "fixed";
        panel.style.right = "12px";
        panel.style.bottom = "12px";
        panel.style.zIndex = "2147483647";
        panel.style.maxWidth = "min(720px, 75vw)";
        panel.style.maxHeight = "50vh";
        panel.style.overflow = "auto";
        panel.style.padding = "12px";
        panel.style.margin = "0";
        panel.style.borderRadius = "10px";
        panel.style.background = "rgba(17,24,39,0.94)";
        panel.style.color = "#e5e7eb";
        panel.style.font = "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace";
        panel.style.whiteSpace = "pre-wrap";
        panel.style.boxShadow = "0 12px 32px rgba(0,0,0,0.35)";
        document.documentElement.appendChild(panel);
      }
      panel.textContent = lines.join("\n");
      return lines.join("\n");
    }
  };
  window.localTranslatorDebug = api;
  window.llt = api;
}
