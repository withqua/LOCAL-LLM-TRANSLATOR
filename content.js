const STATE = {
  translated: false,
  translating: false,
  selectionBubble: null,
  settings: null,
  lastUrl: location.href,
  routeTimer: null,
  autoTranslateObserver: null,
  selectionRequestId: 0,
  translationRunId: 0,
  nextTranslationId: 1
};

const LINK_PAIR_PATTERN = /\[\[\s*LINK_(\d+)\s*]]([\s\S]*?)\[\[\s*\/\s*LINK_\1\s*]]/gi;
const LINK_MARKER_PATTERN = /\[\[\s*\/?\s*LINK_(?:\d+|N)\s*]]/gi;
const GOOGLE_TITLE_SELECTOR = "h3,.LC20lb,[role='heading']";
const TRANSLATION_WIDTHS = new Set(["content", "full"]);
const TRANSLATION_DENSITIES = new Set(["comfortable", "compact"]);
const TITLE_PLACEMENTS = new Set(["auto", "beside", "below"]);
const extensionApi = globalThis.browser || globalThis.chrome;
const USES_PROMISE_API = typeof globalThis.browser !== "undefined";

const TEXT_SELECTOR = [
  "article p",
  "main p",
  "section p",
  "article div",
  "main div",
  "section div",
  ".body-page p",
  ".body-page li",
  ".body-page div",
  ".contents p",
  ".contents li",
  ".contents div",
  ".static-page p",
  ".static-page li",
  ".static-page div",
  "p",
  "article a[href]",
  "main a[href]",
  "section a[href]",
  "header a[href]",
  "nav a[href]",
  "[role='navigation'] a[href]",
  ".d-header a[href]",
  "header button",
  "nav button",
  "[role='navigation'] button",
  ".d-header button",
  ".navigation-container button",
  ".category-breadcrumb button",
  ".nav-pills button",
  "a.title",
  "a.raw-topic-link",
  "a[href].topic-title",
  ".LC20lb",
  "a[href] .LC20lb",
  "shreddit-title",
  "[slot='title']",
  "[data-testid='post-title']",
  "[data-testid*='title']",
  "[data-testid*='description']",
  ".VwiC3b",
  ".IsZvec",
  ".MUxGbd",
  "[data-sncf]",
  ".topic-title",
  ".fancy-title",
  ".link-top-line a",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "td",
  "th"
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

  if (settings.autoTranslate) {
    scheduleAutoTranslate();
  }

  installRouteChangeWatcher();
  installAutoTranslateMutationWatcher();
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
      STATE.settings = { ...STATE.settings, ...(message.settings || {}) };
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
  if (STATE.translated) {
    restorePage();
    return;
  }

  const runId = ++STATE.translationRunId;
  const startUrl = location.href;
  STATE.translating = true;
  showPageStatus("페이지 번역 중...");
  let activeChunk = [];
  let shouldAutoHideStatus = true;
  const keepAlivePort = openTranslationPort();

  try {
    const blocks = collectTranslatableBlocks();
    if (!blocks.length) {
      showPageStatus("번역할 텍스트를 찾지 못했습니다.");
      return;
    }

    let completedCount = 0;
    const totalCount = getBlocksElementCount(blocks);
    for (const chunk of chunkBlocks(blocks, getChunkSize(), getMaxBatchChars())) {
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
      showPageStatus(`페이지 번역 중... ${completedCount}/${totalCount}`);
      activeChunk = [];
    }

    STATE.translated = true;
    showPageStatus("번역 완료.");
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
      if (shouldAutoHideStatus) {
        setTimeout(removePageStatus, 1600);
      }
    }
  }
}

function collectTranslatableBlocks() {
  const elements = Array.from(document.querySelectorAll(TEXT_SELECTOR));
  const blocksByText = new Map();
  const blocks = [];
  const maxBlocks = getMaxBlocks();
  const maxBlockChars = getMaxBlockChars();
  let elementCount = 0;

  for (const element of elements) {
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

    elementCount += 1;
    if (elementCount >= maxBlocks) break;
  }

  return blocks;
}

function getBlocksElementCount(blocks) {
  return blocks.reduce((count, block) => count + block.elements.length, 0);
}

function isGoodCandidate(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  if (element.dataset.lltTranslated === "1") return false;
  if (isGoogleTitleOuterLink(element)) return false;
  if (isContainerWithOwnReadableChildren(element)) return false;
  if (isCompactLabelContainerWithChild(element)) return false;

  const text = extractElementText(element);
  if (text.length < 8 && !shouldUseCompactLabelTranslation(element)) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 8) return false;
  if (isNarrowLongLabel(element, text, rect)) return false;

  return true;
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

  if (options.loading) {
    const spinner = document.createElement("span");
    spinner.className = "llt-spinner";
    spinner.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "llt-loading-text";
    label.textContent = "번역 중...";

    translationElement.append(spinner, label);
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
  } else if (isInlineElement(element) || isContainedBlockElement(element)) {
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
    isInlineElement(element) ||
    isContainedBlockElement(element)
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
  if (text.length <= 28) return true;
  if (text.length > 42) return false;

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

function isContainedBlockElement(element) {
  return ["LI", "TD", "TH"].includes(element.tagName);
}

function isContainerWithOwnReadableChildren(element) {
  if (!["LI", "TD", "TH", "DIV"].includes(element.tagName)) return false;
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
  const links = getElementLinks(element);
  if (!links.length) {
    return { text: extractElementText(element), links };
  }

  let text = extractElementText(element);
  links.forEach((link, index) => {
    const linkText = normalizeText(link.text);
    if (!linkText) return;
    text = text.replace(new RegExp(escapeRegExp(linkText), "u"), `[[LINK_${index}]]${linkText}[[/LINK_${index}]]`);
  });

  return { text, links };
}

function renderTranslationContent(container, translation, sourceElement) {
  container.replaceChildren();
  const normalizedTranslation = normalizeLinkMarkerSyntax(translation);

  if (container.closest("a[href]")) {
    container.textContent = cleanupLinkMarkers(normalizedTranslation);
    return;
  }

  const links = getElementLinks(sourceElement);
  if (!links.length) {
    container.textContent = cleanupLinkMarkers(normalizedTranslation);
    return;
  }

  let lastIndex = 0;
  let match;
  let matched = false;

  LINK_PAIR_PATTERN.lastIndex = 0;
  while ((match = LINK_PAIR_PATTERN.exec(normalizedTranslation)) !== null) {
    matched = true;
    appendText(container, cleanupLinkMarkers(normalizedTranslation.slice(lastIndex, match.index)));

    const linkInfo = links[Number(match[1])];
    if (linkInfo?.href) {
      const anchor = document.createElement("a");
      anchor.className = "llt-translated-link";
      anchor.href = linkInfo.href;
      anchor.target = linkInfo.target || "";
      anchor.rel = linkInfo.rel || "noopener noreferrer";
      anchor.textContent = cleanupLinkMarkers(match[2]) || linkInfo.text;
      container.appendChild(anchor);
    } else {
      appendText(container, cleanupLinkMarkers(match[2]));
    }

    lastIndex = LINK_PAIR_PATTERN.lastIndex;
  }

  appendText(container, cleanupLinkMarkers(normalizedTranslation.slice(lastIndex)));

  const fallback = getDominantLink(links);
  if (!matched && fallback?.href) {
    container.replaceChildren();
    const anchor = document.createElement("a");
    anchor.className = "llt-translated-link";
    anchor.href = fallback.href;
    anchor.target = fallback.target || "";
    anchor.rel = fallback.rel || "noopener noreferrer";
    anchor.textContent = cleanupLinkMarkers(normalizedTranslation);
    container.appendChild(anchor);
  }
}

function getElementLinks(element) {
  const closestLink = element.closest("a[href]");
  const candidates = isLinkElement(element)
    ? [element]
    : closestLink?.contains(element)
      ? [closestLink]
      : Array.from(element.querySelectorAll("a[href]"));

  return candidates
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
    return extractElementText(sourceElement);
  }
  return extractElementText(anchor);
}

function getDominantLink(links) {
  return links.length === 1 ? links[0] : null;
}

function appendText(container, text) {
  if (text) container.appendChild(document.createTextNode(text));
}

function cleanupLinkMarkers(text) {
  return normalizeLinkMarkerSyntax(text).replace(LINK_MARKER_PATTERN, "");
}

function normalizeLinkMarkerSyntax(text) {
  return String(text || "")
    .replace(/\[\[\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[LINK_${index}]]`)
    .replace(/\[\[\s*\/\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[/LINK_${index}]]`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractElementText(element) {
  return normalizeText(element.innerText || element.textContent || "");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferTargetLanguageCode() {
  const target = String(STATE.settings?.targetLanguage || "").trim().toLowerCase();
  if (/^(ko|kor|korean|한국어|한글)$/.test(target)) return "ko";
  if (/^(en|eng|english|영어)$/.test(target)) return "en";
  if (/^(ja|jpn|japanese|일본어)$/.test(target)) return "ja";
  if (/^(zh|zho|chi|chinese|중국어)$/.test(target)) return "zh";
  return "";
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
    if (!STATE.settings?.autoTranslate || STATE.translated || STATE.translating) return;
    if (STATE.routeTimer) return;
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

  if (STATE.settings?.autoTranslate) {
    STATE.routeTimer = setTimeout(() => scheduleAutoTranslate(0), 900);
  }
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
