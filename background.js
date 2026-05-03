const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  targetLanguage: "Korean",
  requestDelayMs: 120,
  maxBatchChars: 1800,
  chunkSize: 4,
  maxBlocks: 160,
  maxBlockChars: 1600,
  requestTimeoutMs: 120000,
  autoTranslate: false,
  translationColor: "#0f766e",
  translationDensity: "comfortable",
  translationWidth: "content",
  titlePlacement: "auto",
  translationOffsetX: 0,
  translationOffsetY: 0,
  customPrompt:
    "Translate webpage text into natural, easy-to-read {targetLanguage}. Use plain modern wording and natural sentence order instead of stiff word-for-word phrasing. Keep short titles concise and title-like; make snippets and paragraphs smooth, readable sentences. Preserve meaning, names, brands, numbers, URLs, technical terms, line breaks, and numeric link placeholders like [[LINK_0]]...[[/LINK_0]] exactly when they appear. Never invent or expose placeholder text. Return only a JSON array of translated strings in the same order."
};

const MAX_CACHE_ITEMS = 600;
const LINK_MARKER_PATTERN = /\[\[\s*\/?\s*LINK_(?:\d+|N)\s*]]/gi;
const LITERAL_LINK_MARKER_PATTERN = /\[\[\s*\/?\s*LINK_N\s*]]/gi;
const LEGACY_DEFAULT_PROMPTS = [
  "Translate the webpage text into {targetLanguage}. Keep the original meaning, names, numbers, technical terms, line breaks, and placeholders like [[LINK_0]]...[[/LINK_0]]. Return only a JSON array of translated strings in the same order.",
  "Translate the webpage text into {targetLanguage}. Keep the original meaning, names, numbers, technical terms, line breaks, and link placeholders like [[LINK_0]]...[[/LINK_0]] exactly when they appear. Do not invent visible placeholder text. Return only a JSON array of translated strings in the same order."
];
const translationCache = new Map();
const activeTranslationControllers = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set(normalizeSettings(stored));

  chrome.contextMenus.create({
    id: "translate-selection",
    title: "선택한 문장 번역",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "translate-selection" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "SHOW_SELECTION_TRANSLATION",
    text: info.selectionText || ""
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-page-translation") {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE_TRANSLATION" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    getSettings()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    const settings = normalizeSettings(message.settings || {});
    chrome.storage.local
      .set(settings)
      .then(() => sendResponse({ ok: true, settings }))
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

  return false;
});

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return normalizeSettings(stored);
}

function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    endpoint: String(merged.endpoint || "").trim() || DEFAULT_SETTINGS.endpoint,
    model: String(merged.model || "").trim() || DEFAULT_SETTINGS.model,
    targetLanguage: String(merged.targetLanguage || "").trim() || DEFAULT_SETTINGS.targetLanguage,
    requestDelayMs: clampNumber(merged.requestDelayMs, DEFAULT_SETTINGS.requestDelayMs, 0, 5000),
    maxBatchChars: clampNumber(merged.maxBatchChars, DEFAULT_SETTINGS.maxBatchChars, 300, 6000),
    chunkSize: clampInteger(merged.chunkSize, DEFAULT_SETTINGS.chunkSize, 1, 8),
    maxBlocks: clampInteger(merged.maxBlocks, DEFAULT_SETTINGS.maxBlocks, 20, 400),
    maxBlockChars: clampInteger(merged.maxBlockChars, DEFAULT_SETTINGS.maxBlockChars, 240, 4000),
    requestTimeoutMs: clampNumber(merged.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 10000, 600000),
    autoTranslate: Boolean(merged.autoTranslate),
    translationColor: normalizeHexColor(merged.translationColor, DEFAULT_SETTINGS.translationColor),
    translationDensity: normalizeChoice(merged.translationDensity, ["comfortable", "compact"], DEFAULT_SETTINGS.translationDensity),
    translationWidth: normalizeChoice(merged.translationWidth, ["content", "full"], DEFAULT_SETTINGS.translationWidth),
    titlePlacement: normalizeChoice(merged.titlePlacement, ["auto", "beside", "below"], DEFAULT_SETTINGS.titlePlacement),
    translationOffsetX: clampNumber(merged.translationOffsetX, DEFAULT_SETTINGS.translationOffsetX, -80, 80),
    translationOffsetY: clampNumber(merged.translationOffsetY, DEFAULT_SETTINGS.translationOffsetY, -80, 80),
    customPrompt: normalizeCustomPrompt(merged.customPrompt)
  };
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
  if (settings.simpleRetry) {
    return `Translate to ${settings.targetLanguage}. Preserve numeric link markers such as [[LINK_0]] and [[/LINK_0]] exactly when present. Return only a JSON array.`;
  }

  const prompt = settings.customPrompt || DEFAULT_SETTINGS.customPrompt;
  return prompt.replaceAll("{targetLanguage}", settings.targetLanguage);
}

function buildUserPayload(texts, settings) {
  return {
    instruction: settings.simpleRetry
      ? `Translate to ${settings.targetLanguage}. Preserve numeric link markers. No mojibake. JSON array only.`
      : "Translate each item using the system rules. Preserve numeric link markers. JSON array only, same order.",
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
    if (!isLikelyBadKoreanTranslation(source, retryValue)) {
      translated[index] = retryValue;
    }
  }
}

function shouldValidateKorean(settings) {
  return /^(ko|kor|korean|한국어|한글)$/i.test(String(settings.targetLanguage || "").trim());
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

  return Array.from({ length: expectedLength }, (_, index) => String(parsed[index] || ""));
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
  return `${settings.model}::${settings.targetLanguage}::${promptKey}::${text}`;
}

function rememberTranslation(key, value) {
  if (!translationCache.has(key) && translationCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(key, value);
}

function normalizeModelTranslation(text) {
  return String(text || "")
    .replace(/\[\[\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[LINK_${index}]]`)
    .replace(/\[\[\s*\/\s*LINK_(\d+)\s*]]/gi, (_, index) => `[[/LINK_${index}]]`)
    .replace(LITERAL_LINK_MARKER_PATTERN, "");
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
