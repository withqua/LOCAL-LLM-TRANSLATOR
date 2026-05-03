const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  sourceLanguage: "auto",
  targetLanguage: "ko",
  requestDelayMs: 0,
  maxBatchChars: 5000,
  chunkSize: 24,
  maxBlocks: 160,
  maxBlockChars: 1600,
  requestTimeoutMs: 120000,
  autoTranslate: false,
  autoTranslateOrigins: [],
  translationColor: "#0f766e",
  translationDensity: "comfortable",
  translationWidth: "content",
  titlePlacement: "auto",
  translationOffsetX: 0,
  translationOffsetY: 0,
  customPrompt:
    "Translate webpage text into natural, easy-to-read {targetLanguage}. Use plain modern wording and natural sentence order instead of stiff word-for-word phrasing. Translate headings fully and faithfully; do not shorten, summarize, or abbreviate titles. Make snippets and paragraphs smooth, readable sentences. Preserve meaning, names, brands, product names, domain names, URLs, email addresses, technical terms, line breaks, and short literal tokens such as bit.ly, tinyurl, forum-help, and ChatGPT exactly when they appear. Keep every URL and domain unchanged. Never omit content. Return only a JSON array of translated strings in the same order."
};

const MAX_CACHE_ITEMS = 600;
const LEGACY_CACHE_STORAGE_KEY = "translationCache";
const LINK_MARKER_PATTERN = /\[\[\s*\/?\s*(?:LINK|TERM)_(?:\d+|N)\s*]]/gi;
const LITERAL_LINK_MARKER_PATTERN = /\[\[\s*\/?\s*(?:LINK|TERM)_N\s*]]/gi;
const LEGACY_DEFAULT_PROMPTS = [
  "Translate the webpage text into {targetLanguage}. Keep the original meaning, names, numbers, technical terms, line breaks, URLs, domain names, email addresses, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT unchanged. Return only a JSON array of translated strings in the same order.",
  "Translate the webpage text into {targetLanguage}. Keep the original meaning, names, numbers, technical terms, line breaks, URLs, domain names, email addresses, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT exactly when they appear. Return only a JSON array of translated strings in the same order.",
  "Translate webpage text into natural, easy-to-read {targetLanguage}. Use plain modern wording and natural sentence order instead of stiff word-for-word phrasing. Keep short titles concise and title-like; make snippets and paragraphs smooth, readable sentences. Preserve meaning, names, brands, numbers, URLs, domain names, email addresses, technical terms, line breaks, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT exactly when they appear. Return only a JSON array of translated strings in the same order."
];
const translationCache = new Map();
const activeTranslationControllers = new Map();
const extensionApi = globalThis.browser || globalThis.chrome;
const USES_PROMISE_API = typeof globalThis.browser !== "undefined";
const registeredContentScripts = new Map();

extensionApi.runtime.onInstalled.addListener(async () => {
  const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
  const settings = normalizeSettings(stored);
  await storageSet(settings);
  await storageRemove(LEGACY_CACHE_STORAGE_KEY).catch(() => {});
  await syncAutoTranslateContentScripts(settings);

  await contextMenusRemoveAll();
  extensionApi.contextMenus.create({
    id: "translate-selection",
    title: "선택한 문장 번역",
    contexts: ["selection"]
  });
});

extensionApi.runtime.onStartup.addListener(async () => {
  await syncAutoTranslateContentScripts(await getSettings());
});

extensionApi.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "translate-selection" || !tab?.id) return;
  if (!(await ensureContentScriptForTab(tab.id))) return;
  sendTabMessage(tab.id, {
    type: "SHOW_SELECTION_TRANSLATION",
    text: info.selectionText || ""
  }).catch(() => {});
});

extensionApi.commands.onCommand.addListener(async (command) => {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-page-translation") {
    if (!(await ensureContentScriptForTab(tab.id))) return;
    sendTabMessage(tab.id, { type: "TOGGLE_PAGE_TRANSLATION" }).catch(() => {});
  }
});

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    getSettings(message.pageUrl || sender?.tab?.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    saveSettings(message.settings || {}, message.pageUrl)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TRANSLATE_TEXTS") {
    const requestKey = getSenderRequestKey(sender, message.scope || "page");
    cancelActiveTranslation(requestKey);

    const controller = new AbortController();
    activeTranslationControllers.set(requestKey, controller);

    translateTexts(message.texts || [], { ...(message.options || {}), signal: controller.signal })
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
      .finally(() => {
        if (activeTranslationControllers.get(requestKey) === controller) {
          activeTranslationControllers.delete(requestKey);
        }
      });
    return true;
  }

  if (message?.type === "CANCEL_TRANSLATION") {
    cancelActiveTranslation(getSenderRequestKey(sender, message.scope || "page"));
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CLEAR_TRANSLATION_CACHE") {
    clearTranslationCache()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

extensionApi.runtime.onConnect.addListener((port) => {
  if (port.name !== "llt-translation") return;
  port.onDisconnect.addListener(() => {});
});

async function getSettings(pageUrl) {
  const stored = await storageGet(Object.keys(DEFAULT_SETTINGS));
  const settings = normalizeSettings(stored);
  return {
    ...settings,
    autoTranslate: isAutoTranslateEnabledForUrl(pageUrl, settings)
  };
}

async function saveSettings(rawSettings, pageUrl) {
  const existing = normalizeSettings(await storageGet(Object.keys(DEFAULT_SETTINGS)));
  const settings = normalizeSettings({ ...existing, ...rawSettings });
  const pageOrigin = getOriginPattern(pageUrl);
  const origins = new Set(settings.autoTranslateOrigins);

  if (pageOrigin) {
    if (settings.autoTranslate) {
      origins.add(pageOrigin);
    } else {
      origins.delete(pageOrigin);
      await permissionsRemove({ origins: [pageOrigin] }).catch(() => false);
    }
  }

  const storedSettings = normalizeSettings({
    ...settings,
    autoTranslate: false,
    autoTranslateOrigins: Array.from(origins).sort()
  });

  await storageSet(storedSettings);
  await syncAutoTranslateContentScripts(storedSettings);

  return {
    ...storedSettings,
    autoTranslate: isAutoTranslateEnabledForUrl(pageUrl, storedSettings)
  };
}

function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const requestDelayMs = clampNumber(merged.requestDelayMs, DEFAULT_SETTINGS.requestDelayMs, 0, 5000);
  const maxBatchChars = clampNumber(merged.maxBatchChars, DEFAULT_SETTINGS.maxBatchChars, 300, 12000);
  const chunkSize = clampInteger(merged.chunkSize, DEFAULT_SETTINGS.chunkSize, 1, 24);

  return {
    ...merged,
    endpoint: String(merged.endpoint || "").trim() || DEFAULT_SETTINGS.endpoint,
    model: String(merged.model || "").trim() || DEFAULT_SETTINGS.model,
    sourceLanguage: normalizeChoice(String(merged.sourceLanguage || "").trim(), ["auto", "en", "ko", "ja", "zh", "es"], DEFAULT_SETTINGS.sourceLanguage),
    targetLanguage: normalizeChoice(String(merged.targetLanguage || "").trim(), ["en", "ko", "ja", "zh", "es"], DEFAULT_SETTINGS.targetLanguage),
    requestDelayMs,
    maxBatchChars,
    chunkSize,
    maxBlocks: clampInteger(merged.maxBlocks, DEFAULT_SETTINGS.maxBlocks, 20, 400),
    maxBlockChars: clampInteger(merged.maxBlockChars, DEFAULT_SETTINGS.maxBlockChars, 240, 4000),
    requestTimeoutMs: clampNumber(merged.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 10000, 600000),
    autoTranslate: Boolean(merged.autoTranslate),
    autoTranslateOrigins: normalizeOriginPatterns(merged.autoTranslateOrigins),
    translationColor: normalizeHexColor(merged.translationColor, DEFAULT_SETTINGS.translationColor),
    translationDensity: normalizeChoice(merged.translationDensity, ["comfortable", "compact"], DEFAULT_SETTINGS.translationDensity),
    translationWidth: normalizeChoice(merged.translationWidth, ["content", "full"], DEFAULT_SETTINGS.translationWidth),
    titlePlacement: normalizeChoice(merged.titlePlacement, ["auto", "beside", "below"], DEFAULT_SETTINGS.titlePlacement),
    translationOffsetX: clampNumber(merged.translationOffsetX, DEFAULT_SETTINGS.translationOffsetX, -80, 80),
    translationOffsetY: clampNumber(merged.translationOffsetY, DEFAULT_SETTINGS.translationOffsetY, -80, 80),
    customPrompt: normalizeCustomPrompt(merged.customPrompt)
  };
}

function normalizeOriginPatterns(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(isSupportedOriginPattern))).sort();
}

function isSupportedOriginPattern(pattern) {
  return /^https?:\/\/(?:\*\.)?[^/*:]+\/\*$/.test(pattern);
}

function getOriginPattern(pageUrl) {
  try {
    const url = new URL(pageUrl || "");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return "";
  }
}

function isAutoTranslateEnabledForUrl(pageUrl, settings) {
  const origin = getOriginPattern(pageUrl);
  return Boolean(origin && settings.autoTranslateOrigins.includes(origin));
}

async function syncAutoTranslateContentScripts(settings) {
  const registered = await scriptingGetRegisteredContentScripts();
  const currentIds = registered
    .map((script) => script.id)
    .filter((id) => id.startsWith("llt-auto-translate-"));

  if (currentIds.length) {
    await scriptingUnregisterContentScripts({ ids: currentIds });
  }

  const origins = [];
  for (const origin of settings.autoTranslateOrigins) {
    if (await permissionsContains({ origins: [origin] })) {
      origins.push(origin);
    }
  }

  if (!origins.length) return;

  await scriptingRegisterContentScripts(origins.map((origin) => ({
    id: getAutoTranslateScriptId(origin),
    matches: [origin],
    js: ["content.js"],
    css: ["content.css"],
    runAt: "document_idle"
  })));
}

function getAutoTranslateScriptId(origin) {
  let hash = 0;
  for (let index = 0; index < origin.length; index += 1) {
    hash = ((hash << 5) - hash + origin.charCodeAt(index)) | 0;
  }
  return `llt-auto-translate-${Math.abs(hash)}`;
}

async function ensureContentScriptForTab(tabId) {
  try {
    await sendTabMessage(tabId, { type: "PING" });
    return true;
  } catch {
    try {
      await scriptingInsertCSS({ target: { tabId }, files: ["content.css"] });
      await scriptingExecuteScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch {
      return false;
    }
  }
}

function callExtensionApi(method, ...args) {
  if (USES_PROMISE_API) {
    return method(...args);
  }

  return new Promise((resolve, reject) => {
    method(...args, (result) => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageGet(keys) {
  return callExtensionApi(extensionApi.storage.local.get.bind(extensionApi.storage.local), keys);
}

function storageSet(items) {
  return callExtensionApi(extensionApi.storage.local.set.bind(extensionApi.storage.local), items);
}

function storageRemove(keys) {
  return callExtensionApi(extensionApi.storage.local.remove.bind(extensionApi.storage.local), keys);
}

function contextMenusRemoveAll() {
  return callExtensionApi(extensionApi.contextMenus.removeAll.bind(extensionApi.contextMenus));
}

function tabsQuery(queryInfo) {
  return callExtensionApi(extensionApi.tabs.query.bind(extensionApi.tabs), queryInfo);
}

function sendTabMessage(tabId, message) {
  return callExtensionApi(extensionApi.tabs.sendMessage.bind(extensionApi.tabs), tabId, message);
}

function permissionsContains(permissions) {
  return callExtensionApi(extensionApi.permissions.contains.bind(extensionApi.permissions), permissions);
}

function permissionsRemove(permissions) {
  return callExtensionApi(extensionApi.permissions.remove.bind(extensionApi.permissions), permissions);
}

function scriptingGetRegisteredContentScripts() {
  if (extensionApi.scripting?.getRegisteredContentScripts) {
    return callExtensionApi(extensionApi.scripting.getRegisteredContentScripts.bind(extensionApi.scripting));
  }

  if (!extensionApi.contentScripts?.register) {
    return Promise.resolve([]);
  }

  return Promise.resolve(
    Array.from(registeredContentScripts.keys()).map((id) => ({ id }))
  );
}

async function scriptingRegisterContentScripts(scripts) {
  if (extensionApi.scripting?.registerContentScripts) {
    return callExtensionApi(extensionApi.scripting.registerContentScripts.bind(extensionApi.scripting), scripts);
  }

  if (!extensionApi.contentScripts?.register) return;

  for (const script of scripts || []) {
    if (!script?.matches?.length) continue;
    const registration = await extensionApi.contentScripts.register({
      matches: script.matches,
      js: script.js,
      css: script.css,
      runAt: script.runAt || "document_idle"
    });
    if (script.id) {
      registeredContentScripts.set(script.id, registration);
    }
  }
}

async function scriptingUnregisterContentScripts(filter) {
  if (extensionApi.scripting?.unregisterContentScripts) {
    return callExtensionApi(extensionApi.scripting.unregisterContentScripts.bind(extensionApi.scripting), filter);
  }

  if (!extensionApi.contentScripts?.register) return;

  const ids = filter?.ids || [];
  for (const id of ids) {
    const registration = registeredContentScripts.get(id);
    if (!registration) continue;
    await registration.unregister();
    registeredContentScripts.delete(id);
  }
}

function scriptingInsertCSS(details) {
  if (extensionApi.scripting?.insertCSS) {
    return callExtensionApi(extensionApi.scripting.insertCSS.bind(extensionApi.scripting), details);
  }

  const tabId = details?.target?.tabId;
  if (!tabId) return Promise.reject(new Error("Missing tab id."));
  return callExtensionApi(extensionApi.tabs.insertCSS.bind(extensionApi.tabs), tabId, { file: "content.css" });
}

function scriptingExecuteScript(details) {
  if (extensionApi.scripting?.executeScript) {
    return callExtensionApi(extensionApi.scripting.executeScript.bind(extensionApi.scripting), details);
  }

  const tabId = details?.target?.tabId;
  if (!tabId) return Promise.reject(new Error("Missing tab id."));
  return callExtensionApi(extensionApi.tabs.executeScript.bind(extensionApi.tabs), tabId, { file: "content.js" });
}

function normalizeHexColor(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeCustomPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt || LEGACY_DEFAULT_PROMPTS.includes(prompt)) {
    return DEFAULT_SETTINGS.customPrompt;
  }
  return prompt;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

async function translateTexts(texts, options = {}) {
  const settings = normalizeSettings({ ...(await getSettings()), ...options });
  const cleaned = texts.map((text) => normalizeText(text));
  const results = new Array(cleaned.length);
  const misses = [];

  cleaned.forEach((text, index) => {
    const key = cacheKey(text, settings);
    if (translationCache.has(key)) {
      results[index] = translationCache.get(key);
    } else {
      misses.push({ text, index, key });
    }
  });

  const batches = buildBatches(misses, settings.maxBatchChars);
  for (const batch of batches) {
    throwIfAborted(settings.signal);
    const translated = await requestLmStudio(batch.map((item) => item.text), settings);
    throwIfAborted(settings.signal);

    await retryBadTranslations(batch, translated, settings);
    await retryMissingTranslations(batch, translated, settings);
    await retrySuspiciousTranslations(batch, translated, settings);

    batch.forEach((item, batchIndex) => {
      const value = normalizeModelTranslation(translated[batchIndex] || "");
      rememberTranslation(item.key, value);
      results[item.index] = value;
    });

    if (settings.requestDelayMs > 0) {
      await sleep(settings.requestDelayMs, settings.signal);
    }
  }

  return results;
}

async function requestLmStudio(texts, settings) {
  if (!texts.length) return [];

  const controller = new AbortController();
  const abortFromOuterSignal = () => controller.abort();
  if (settings.signal) {
    if (settings.signal.aborted) {
      throw new Error("Translation canceled.");
    }
    settings.signal.addEventListener("abort", abortFromOuterSignal, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  let response;
  try {
    response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You are a precise webpage translator. Return only valid JSON. " +
              buildPrompt(settings)
          },
          {
            role: "user",
            content: JSON.stringify(buildUserPayload(texts, settings))
          }
        ]
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      if (settings.signal?.aborted) throw new Error("Translation canceled.");
      throw new Error("LM Studio request timed out. Try a smaller model or lower batch size.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    settings.signal?.removeEventListener("abort", abortFromOuterSignal);
  }

  if (!response.ok) {
    throw new Error(`LM Studio request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseTranslationArray(content, texts.length);
}

function buildPrompt(settings) {
  const targetLabel = getLanguageLabel(settings.targetLanguage);
  const sourceInstruction = settings.sourceLanguage === "auto"
    ? "The source language may vary by text item."
    : `The preferred source language is ${getLanguageLabel(settings.sourceLanguage)}.`;

  if (settings.simpleRetry) {
    return `Translate to ${targetLabel}. ${sourceInstruction} Preserve URLs, domain names, email addresses, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT exactly when present. Return only a JSON array.`;
  }

  const prompt = settings.customPrompt || DEFAULT_SETTINGS.customPrompt;
  return prompt
    .replaceAll("{targetLanguage}", targetLabel)
    .replaceAll("{sourceLanguage}", settings.sourceLanguage === "auto" ? "Auto-detect" : getLanguageLabel(settings.sourceLanguage));
}

function buildUserPayload(texts, settings) {
  const targetLabel = getLanguageLabel(settings.targetLanguage);
  return {
    instruction: settings.simpleRetry
      ? `Translate to ${targetLabel}. Preserve URLs, domain names, email addresses, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT exactly. No mojibake. JSON array only.`
      : `Translate each item to ${targetLabel}. Preserve URLs, domain names, email addresses, and literals such as bit.ly, tinyurl, forum-help, and ChatGPT exactly. JSON array only, same order.`,
    texts
  };
}

async function retryBadTranslations(batch, translated, settings) {
  if (!shouldValidateKorean(settings)) return;

  for (let index = 0; index < batch.length; index += 1) {
    const source = batch[index].text;
    const value = translated[index] || "";
    if (!isLikelyBadKoreanTranslation(source, value)) continue;

    throwIfAborted(settings.signal);
    const retried = await requestLmStudio([source], { ...settings, simpleRetry: true, maxBatchChars: source.length });
    const retryValue = retried[0] || "";
    if (!isLikelyBadKoreanTranslation(source, retryValue) && !hasBrokenAnyMarkers(source, retryValue)) {
      translated[index] = retryValue;
    }
  }
}

async function retryMissingTranslations(batch, translated, settings) {
  for (let index = 0; index < batch.length; index += 1) {
    const source = batch[index].text;
    const value = translated[index] || "";
    if (!shouldRetryMissingTranslation(source, value, settings)) continue;

    throwIfAborted(settings.signal);
    const retried = await requestLmStudio([source], { ...settings, simpleRetry: true, maxBatchChars: source.length });
    const retryValue = retried[0] || "";
    if (normalizeModelTranslation(retryValue) && !shouldRetryMissingTranslation(source, retryValue, settings)) {
      translated[index] = retryValue;
    }
  }
}

async function retrySuspiciousTranslations(batch, translated, settings) {
  for (let index = 0; index < batch.length; index += 1) {
    const source = batch[index].text;
    const value = translated[index] || "";
    if (!shouldRetrySuspiciousTranslation(source, value, settings)) continue;

    throwIfAborted(settings.signal);
    const retried = await requestLmStudio([source], { ...settings, simpleRetry: true, maxBatchChars: source.length });
    const retryValue = retried[0] || "";
    if (normalizeModelTranslation(retryValue) && !shouldRetrySuspiciousTranslation(source, retryValue, settings)) {
      translated[index] = retryValue;
    }
  }
}

function shouldRetryMissingTranslation(source, translated, settings) {
  const normalizedSource = normalizeText(stripLinkMarkers(source));
  const normalizedTranslated = normalizeText(stripLinkMarkers(translated));
  if (!normalizedSource) return false;

  if (!normalizedTranslated) {
    return normalizedSource.length >= 3;
  }

  if (hasBrokenAnyMarkers(source, translated)) {
    return true;
  }

  if (isMissingProtectedLiterals(normalizedSource, normalizedTranslated)) {
    return true;
  }

  const target = String(settings.targetLanguage || "").trim().toLowerCase();
  const sourceLooksLikeTarget = detectSimpleLanguage(normalizedSource) === target;
  if (sourceLooksLikeTarget) return false;

  return normalizedTranslated === normalizedSource;
}

function shouldRetrySuspiciousTranslation(source, translated, settings) {
  const normalizedSource = normalizeText(stripLinkMarkers(source));
  const normalizedTranslated = normalizeText(stripLinkMarkers(translated));
  if (!normalizedSource || !normalizedTranslated) return false;

  if (normalizedTranslated === "[object Object]") return true;

  const sourceWords = normalizedSource.split(/\s+/).filter(Boolean).length;
  const isShortHeadingLikeSource =
    normalizedSource.length <= 80 &&
    sourceWords <= 8 &&
    !/[.!?。！？]\s*$/.test(normalizedSource);

  if (!isShortHeadingLikeSource) return false;

  if (normalizedTranslated.includes("\n")) return true;
  if (normalizedTranslated.length >= Math.max(90, normalizedSource.length * 3)) return true;

  return false;
}

function hasBrokenAnyMarkers(source, translated) {
  return hasBrokenMarkersByType(source, translated, "LINK")
    || hasBrokenMarkersByType(source, translated, "TERM");
}

function hasBrokenMarkersByType(source, translated, type) {
  const sourceMarkers = collectMarkerIds(source, type);
  if (!sourceMarkers.length) return false;

  const translatedMarkers = collectMarkerIds(translated, type);
  if (translatedMarkers.length !== sourceMarkers.length) return true;

  for (const marker of sourceMarkers) {
    if (!translatedMarkers.includes(marker)) return true;
  }

  return false;
}

function collectMarkerIds(text, type) {
  const ids = [];
  const pattern = new RegExp(`(?:\\[\\[|\\[)\\s*${type}_(\\d+)\\s*(?:]]|])`, "gi");
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function isMissingProtectedLiterals(source, translated) {
  const literals = extractProtectedLiterals(source);
  if (!literals.length) return false;

  const translatedLower = String(translated || "").toLowerCase();
  return literals.some((literal) => !translatedLower.includes(literal.toLowerCase()));
}

function extractProtectedLiterals(text) {
  const matches = String(text || "").match(/\b(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s)\]]*)?|tinyurl|forum-help|chatgpt|bitly)\b/gi) || [];
  return Array.from(new Set(matches.filter(Boolean)));
}

function shouldValidateKorean(settings) {
  return String(settings.targetLanguage || "").trim() === "ko";
}

function isLikelyBadKoreanTranslation(source, translated) {
  const plainSource = stripLinkMarkers(source);
  const plainTranslated = stripLinkMarkers(translated);
  if (plainSource.length < 12 || plainTranslated.length < 3) return false;
  if (!/[A-Za-z]{3,}/.test(plainSource)) return false;

  const hangulCount = countMatches(plainTranslated, /[가-힣]/g);
  if (hangulCount >= 2) return false;

  const latinCount = countMatches(plainTranslated, /[A-Za-z]/g);
  const suspiciousCount = countMatches(plainTranslated, /[µâêîôûãõāăąćęłńóśźżɀ-ʯ]/gi);
  return suspiciousCount >= 2 || latinCount > plainTranslated.length * 0.45;
}

function stripLinkMarkers(text) {
  return normalizeModelTranslation(text).replace(LINK_MARKER_PATTERN, "");
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function detectSimpleLanguage(text) {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  if (/[가-힣]/.test(normalized)) return "ko";
  if (/[\u3040-\u30ff]/.test(normalized)) return "ja";
  if (/[\u4e00-\u9fff]/.test(normalized)) return "zh";

  const lower = normalized.toLowerCase();
  const spanishHints = countMatches(lower, /\b(el|la|los|las|de|del|para|como|que|por|una|un|y|en)\b/g)
    + countMatches(lower, /[áéíóúñ¿¡]/g);
  const englishHints = countMatches(lower, /\b(the|and|with|that|this|from|you|your|for|page|guide|memory|forum)\b/g);

  if (spanishHints >= englishHints + 2) return "es";
  if (englishHints > 0) return "en";
  return "";
}

function parseTranslationArray(content, expectedLength) {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Local model did not return a JSON array.");
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed) && Array.isArray(parsed?.translations)) {
    parsed = parsed.translations;
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Local model response is not an array.");
  }

  return Array.from({ length: expectedLength }, (_, index) => coerceTranslationValue(parsed[index]));
}

function buildBatches(items, maxChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    if (current.length && currentChars + itemChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }

  if (current.length) batches.push(current);
  return batches;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cacheKey(text, settings) {
  const promptKey = normalizeText(settings.customPrompt || DEFAULT_SETTINGS.customPrompt);
  return `${settings.model}::${settings.sourceLanguage}::${settings.targetLanguage}::${promptKey}::${text}`;
}

function getLanguageLabel(code) {
  switch (String(code || "").trim()) {
    case "en":
      return "English";
    case "ko":
      return "Korean";
    case "ja":
      return "Japanese";
    case "zh":
      return "Chinese";
    case "es":
      return "Spanish";
    default:
      return "Auto-detect";
  }
}

function rememberTranslation(key, value) {
  if (!value) return false;

  const previous = translationCache.get(key);
  if (previous === value) return false;

  if (!translationCache.has(key) && translationCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(key, value);
  return true;
}

async function clearTranslationCache() {
  const count = translationCache.size;
  translationCache.clear();
  await storageRemove(LEGACY_CACHE_STORAGE_KEY).catch(() => {});
  return count;
}

function normalizeModelTranslation(text) {
  return String(text || "")
    .replace(/\[\s*(LINK|TERM)_(\d+)\s*]]/gi, (_, type, index) => `[[${type.toUpperCase()}_${index}]]`)
    .replace(/\[\s*\/\s*(LINK|TERM)_(\d+)\s*]]/gi, (_, type, index) => `[[/${type.toUpperCase()}_${index}]]`)
    .replace(/\[\[\s*(LINK|TERM)_(\d+)\s*]/gi, (_, type, index) => `[[${type.toUpperCase()}_${index}]]`)
    .replace(/\[\[\s*\/\s*(LINK|TERM)_(\d+)\s*]/gi, (_, type, index) => `[[/${type.toUpperCase()}_${index}]]`)
    .replace(/\[\[\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[LINK_${index}]]`)
    .replace(/\[\[\s*\/\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[/LINK_${index}]]`)
    .replace(/\[\[\s*TERM_(\d+)\s*]]/gi, (_, index) => `[[TERM_${index}]]`)
    .replace(/\[\[\s*\/\s*TERM_(\d+)\s*]]/gi, (_, index) => `[[/TERM_${index}]]`)
    .replace(LITERAL_LINK_MARKER_PATTERN, "");
}

function coerceTranslationValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    const candidates = [
      value.translation,
      value.translated,
      value.text,
      value.content,
      value.output
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
  }
  return String(value || "");
}

function getSenderRequestKey(sender, scope = "page") {
  const normalizedScope = scope === "selection" ? "selection" : "page";
  return sender?.tab?.id ? `tab:${sender.tab.id}:${normalizedScope}` : `global:${normalizedScope}`;
}

function cancelActiveTranslation(requestKey) {
  const controller = activeTranslationControllers.get(requestKey);
  if (!controller) return;

  controller.abort();
  activeTranslationControllers.delete(requestKey);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Translation canceled.");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Translation canceled."));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Translation canceled."));
    }, { once: true });
  });
}
