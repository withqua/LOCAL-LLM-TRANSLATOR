const fields = {
  togglePage: document.querySelector("#toggle-page"),
  save: document.querySelector("#save"),
  endpoint: document.querySelector("#endpoint"),
  model: document.querySelector("#model"),
  targetLanguage: document.querySelector("#target-language"),
  requestTimeoutMs: document.querySelector("#request-timeout-ms"),
  autoTranslate: document.querySelector("#auto-translate"),
  translationColor: document.querySelector("#translation-color"),
  translationDensity: document.querySelector("#translation-density"),
  translationWidth: document.querySelector("#translation-width"),
  titlePlacement: document.querySelector("#title-placement"),
  translationOffsetX: document.querySelector("#translation-offset-x"),
  translationOffsetY: document.querySelector("#translation-offset-y"),
  chunkSize: document.querySelector("#chunk-size"),
  maxBlocks: document.querySelector("#max-blocks"),
  maxBlockChars: document.querySelector("#max-block-chars"),
  customPrompt: document.querySelector("#custom-prompt"),
  status: document.querySelector("#status")
};

fields.togglePage.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus("활성 탭을 찾지 못했습니다.", "error");
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
  const settings = {
    endpoint: fields.endpoint.value.trim(),
    model: fields.model.value.trim(),
    targetLanguage: fields.targetLanguage.value.trim(),
    requestTimeoutMs: Number(fields.requestTimeoutMs.value) || 120000,
    autoTranslate: fields.autoTranslate.checked,
    translationColor: fields.translationColor.value,
    translationDensity: fields.translationDensity.value,
    translationWidth: fields.translationWidth.value,
    titlePlacement: fields.titlePlacement.value,
    translationOffsetX: Number(fields.translationOffsetX.value) || 0,
    translationOffsetY: Number(fields.translationOffsetY.value) || 0,
    chunkSize: Number(fields.chunkSize.value) || 4,
    maxBlocks: Number(fields.maxBlocks.value) || 160,
    maxBlockChars: Number(fields.maxBlockChars.value) || 1600,
    customPrompt: fields.customPrompt.value.trim()
  };

  setSaving(true);

  try {
    const saved = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    if (!saved?.ok) throw new Error(saved?.error || "설정 저장 실패");

    applySettings(saved.settings || settings);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await sendTabMessage(tab.id, {
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

load();

async function load() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (settings?.error) throw new Error(settings.error);
    applySettings(settings);
  } catch (error) {
    showStatus(error.message || "설정을 불러오지 못했습니다.", "error");
  }
}

function applySettings(settings) {
  fields.endpoint.value = settings.endpoint || "";
  fields.model.value = settings.model || "";
  fields.targetLanguage.value = settings.targetLanguage || "";
  fields.requestTimeoutMs.value = settings.requestTimeoutMs || 120000;
  fields.autoTranslate.checked = Boolean(settings.autoTranslate);
  fields.translationColor.value = settings.translationColor || "#0f766e";
  fields.translationDensity.value = settings.translationDensity || "comfortable";
  fields.translationWidth.value = settings.translationWidth || "content";
  fields.titlePlacement.value = settings.titlePlacement || "auto";
  fields.translationOffsetX.value = settings.translationOffsetX ?? 0;
  fields.translationOffsetY.value = settings.translationOffsetY ?? 0;
  fields.chunkSize.value = settings.chunkSize || 4;
  fields.maxBlocks.value = settings.maxBlocks || 160;
  fields.maxBlockChars.value = settings.maxBlockChars || 1600;
  fields.customPrompt.value = settings.customPrompt || "";
}

function setSaving(isSaving) {
  fields.save.disabled = isSaving;
  fields.save.textContent = isSaving ? "저장 중..." : "설정 저장";
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
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve({ ok: true });
    });
  });
}
