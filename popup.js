const fields = {
  togglePage: document.querySelector("#toggle-page"),
  save: document.querySelector("#save"),
  clearCache: document.querySelector("#clear-cache"),
  endpoint: document.querySelector("#endpoint"),
  model: document.querySelector("#model"),
  sourceLanguage: document.querySelector("#source-language"),
  targetLanguage: document.querySelector("#target-language"),
  requestTimeoutMs: document.querySelector("#request-timeout-ms"),
  requestDelayMs: document.querySelector("#request-delay-ms"),
  autoTranslate: document.querySelector("#auto-translate"),
  translationColor: document.querySelector("#translation-color"),
  translationDensity: document.querySelector("#translation-density"),
  translationWidth: document.querySelector("#translation-width"),
  titlePlacement: document.querySelector("#title-placement"),
  translationOffsetX: document.querySelector("#translation-offset-x"),
  translationOffsetY: document.querySelector("#translation-offset-y"),
  chunkSize: document.querySelector("#chunk-size"),
  maxBatchChars: document.querySelector("#max-batch-chars"),
  maxBlocks: document.querySelector("#max-blocks"),
  maxBlockChars: document.querySelector("#max-block-chars"),
  customPrompt: document.querySelector("#custom-prompt"),
  status: document.querySelector("#status")
};
const extensionApi = globalThis.browser || globalThis.chrome;
const USES_PROMISE_API = typeof globalThis.browser !== "undefined";
let activeTab = null;

fields.togglePage.addEventListener("click", async () => {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus("활성 탭을 찾지 못했습니다.", "error");
    return;
  }

  try {
    await ensureContentScript(tab.id);
  } catch {
    showStatus("이 페이지에서는 사용할 수 없습니다.", "error");
    return;
  }

  const response = await sendTabMessage(tab.id, { type: "TOGGLE_PAGE_TRANSLATION" });
  if (!response.ok) {
    showStatus("이 페이지에서는 사용할 수 없습니다.", "error");
    return;
  }

  window.close();
});

fields.save.addEventListener("click", async () => {
  const pageUrl = activeTab?.url || "";
  const settings = {
    endpoint: fields.endpoint.value.trim(),
    model: fields.model.value.trim(),
    sourceLanguage: fields.sourceLanguage.value.trim(),
    targetLanguage: fields.targetLanguage.value.trim(),
    requestTimeoutMs: Number(fields.requestTimeoutMs.value) || 120000,
    requestDelayMs: Number(fields.requestDelayMs.value) || 0,
    autoTranslate: fields.autoTranslate.checked,
    translationColor: fields.translationColor.value,
    translationDensity: fields.translationDensity.value,
    translationWidth: fields.translationWidth.value,
    titlePlacement: fields.titlePlacement.value,
    translationOffsetX: Number(fields.translationOffsetX.value) || 0,
    translationOffsetY: Number(fields.translationOffsetY.value) || 0,
    chunkSize: Number(fields.chunkSize.value) || 24,
    maxBatchChars: Number(fields.maxBatchChars.value) || 5000,
    maxBlocks: Number(fields.maxBlocks.value) || 160,
    maxBlockChars: Number(fields.maxBlockChars.value) || 1600,
    customPrompt: fields.customPrompt.value.trim()
  };

  try {
    const permissionRequest = requestAutoTranslatePermission(settings.autoTranslate, pageUrl);
    setSaving(true);
    await permissionRequest;

    const saved = await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings, pageUrl });
    if (!saved?.ok) throw new Error(saved?.error || "설정 저장 실패");

    applySettings(saved.settings || settings);

    if (activeTab?.id) {
      if (saved.settings?.autoTranslate) {
        await ensureContentScript(activeTab.id);
      }

      await sendTabMessage(activeTab.id, {
        type: "SET_SETTINGS",
        settings: saved.settings || settings
      });
    }

    showStatus("저장했습니다.");
  } catch (error) {
    showStatus(error.message || "설정 저장 실패", "error");
  } finally {
    setSaving(false);
  }
});

fields.clearCache.addEventListener("click", async () => {
  setCacheClearing(true);

  try {
    const response = await sendRuntimeMessage({ type: "CLEAR_TRANSLATION_CACHE" });
    if (!response?.ok) throw new Error(response?.error || "캐시 삭제 실패");

    showStatus(`메모리 캐시 ${response.count || 0}개를 삭제했습니다.`);
  } catch (error) {
    showStatus(error.message || "캐시 삭제 실패", "error");
  } finally {
    setCacheClearing(false);
  }
});

load();

async function load() {
  try {
    [activeTab] = await tabsQuery({ active: true, currentWindow: true });
    const settings = await sendRuntimeMessage({ type: "GET_SETTINGS", pageUrl: activeTab?.url || "" });
    if (settings?.error) throw new Error(settings.error);
    applySettings(settings);
  } catch (error) {
    showStatus(error.message || "설정을 불러오지 못했습니다.", "error");
  }
}

function applySettings(settings) {
  fields.endpoint.value = settings.endpoint || "";
  fields.model.value = settings.model || "";
  fields.sourceLanguage.value = settings.sourceLanguage || "auto";
  fields.targetLanguage.value = settings.targetLanguage || "ko";
  fields.requestTimeoutMs.value = settings.requestTimeoutMs || 120000;
  fields.requestDelayMs.value = settings.requestDelayMs ?? 0;
  fields.autoTranslate.checked = Boolean(settings.autoTranslate);
  fields.translationColor.value = settings.translationColor || "#0f766e";
  fields.translationDensity.value = settings.translationDensity || "comfortable";
  fields.translationWidth.value = settings.translationWidth || "content";
  fields.titlePlacement.value = settings.titlePlacement || "auto";
  fields.translationOffsetX.value = settings.translationOffsetX ?? 0;
  fields.translationOffsetY.value = settings.translationOffsetY ?? 0;
  fields.chunkSize.value = settings.chunkSize || 24;
  fields.maxBatchChars.value = settings.maxBatchChars || 5000;
  fields.maxBlocks.value = settings.maxBlocks || 160;
  fields.maxBlockChars.value = settings.maxBlockChars || 1600;
  fields.customPrompt.value = settings.customPrompt || "";
}

function setSaving(isSaving) {
  fields.save.disabled = isSaving;
  fields.save.textContent = isSaving ? "저장 중..." : "설정 저장";
}

function setCacheClearing(isClearing) {
  fields.clearCache.disabled = isClearing;
  fields.clearCache.textContent = isClearing ? "삭제 중..." : "메모리 캐시 삭제";
}

function showStatus(text, type = "success") {
  fields.status.textContent = text;
  fields.status.className = type === "error" ? "error" : "";

  if (type !== "error") {
    setTimeout(() => {
      fields.status.textContent = "";
      fields.status.className = "";
    }, 1400);
  }
}

function sendTabMessage(tabId, message) {
  return callExtensionApi(extensionApi.tabs.sendMessage.bind(extensionApi.tabs), tabId, message)
    .then((response) => response || { ok: true })
    .catch((error) => ({ ok: false, error: error.message }));
}

async function ensureContentScript(tabId) {
  const ping = await sendTabMessage(tabId, { type: "PING" });
  if (ping.ok) return;

  await scriptingInsertCSS({ target: { tabId }, files: ["content.css"] });
  await scriptingExecuteScript({ target: { tabId }, files: ["content.js"] });
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

function requestAutoTranslatePermission(autoTranslate, pageUrl) {
  if (!autoTranslate) return Promise.resolve();

  const origin = getOriginPattern(pageUrl);
  if (!origin) {
    return Promise.reject(new Error("이 페이지는 도메인별 자동 번역을 사용할 수 없습니다."));
  }

  return permissionsRequest({ origins: [origin] }).then((granted) => {
    if (!granted) throw new Error("현재 도메인 권한이 필요합니다.");
  });
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

function tabsQuery(queryInfo) {
  return callExtensionApi(extensionApi.tabs.query.bind(extensionApi.tabs), queryInfo);
}

function permissionsRequest(permissions) {
  return callExtensionApi(extensionApi.permissions.request.bind(extensionApi.permissions), permissions);
}

function sendRuntimeMessage(message) {
  return callExtensionApi(extensionApi.runtime.sendMessage.bind(extensionApi.runtime), message);
}

function scriptingInsertCSS(details) {
  return callExtensionApi(extensionApi.scripting.insertCSS.bind(extensionApi.scripting), details);
}

function scriptingExecuteScript(details) {
  return callExtensionApi(extensionApi.scripting.executeScript.bind(extensionApi.scripting), details);
}
