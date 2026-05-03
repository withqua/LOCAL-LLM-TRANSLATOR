# Local LLM Bilingual Translator

**Recommendation (EN)**

We recommend the Gemma 4 model the most.
Gemma 4 2B and 4B are sufficient for most cases.

**추천 (KR)**

Gemma 4 모델을 가장 추천합니다.
Gemma 4 2B, 4B로도 대부분의 상황에서 충분합니다.

**Note (EN)**

In the popup, set the model name to the exact LM Studio model name you are serving.

**주의사항 (KR)**

팝업의 모델 이름 입력란에는 LM Studio에서 서빙한 모델명을 정확히 입력해야 합니다.

Personal Chrome, Chromium, and Firefox extension sample for bilingual webpage translation with LM Studio.

## 한국어

LM Studio를 사용해 웹페이지를 이중 언어로 번역하는 개인용 Chrome, Chromium, Firefox 확장 샘플입니다.

## Features

- Whole page translation with original text plus translated text.
- Selection translation from the context menu.
- Optional auto-translate for newly opened pages on domains you explicitly enable.
- Custom translation prompt.
- Adjustable translation color, density, width, title placement, and alignment offset.
- Token controls for page chunk size, maximum translated blocks, and maximum characters per block.
- Local OpenAI-compatible API through LM Studio.
- Best-effort preservation of translated links without showing raw `[[LINK_0]]` markers.

## 기능

- 원문과 번역문을 함께 표시하는 전체 페이지 번역.
- 컨텍스트 메뉴에서 선택 텍스트 번역.
- 명시적으로 켠 도메인의 새 페이지 자동 번역(옵션).
- 번역 프롬프트 커스텀.
- 번역 색상, 밀도, 너비, 제목 배치, 정렬 오프셋 조정.
- 페이지 청크 크기, 최대 번역 블록 수, 블록당 최대 문자 수 토큰 제어.
- LM Studio를 통한 로컬 OpenAI 호환 API.
- `[[LINK_0]]` 같은 원시 마커를 노출하지 않고 링크를 최대한 보존.

## LM Studio

1. Open LM Studio.
2. Load a chat/instruct model.
3. Start the local server.
4. Keep the default endpoint:

```text
http://localhost:1234/v1/chat/completions
```

The extension stores `model` as `local-model` by default. LM Studio usually accepts this when only one model is served, but you can change it in the popup.

## LM Studio (한국어)

1. LM Studio를 엽니다.
2. 채팅/인스트럭트 모델을 로드합니다.
3. 로컬 서버를 시작합니다.
4. 기본 엔드포인트를 유지합니다:

```text
http://localhost:1234/v1/chat/completions
```

확장은 기본값으로 `model`을 `local-model`로 저장합니다. 보통 LM Studio에 모델이 하나만 열려 있으면 이 이름이 그대로 동작하지만, 팝업에서 변경할 수 있습니다.

## Install Chrome

1. Open Chrome or a Chromium browser.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click "Load unpacked".
5. Select this project folder.

## Install Firefox

1. Run:

```sh
node scripts/prepare-firefox.mjs
```

2. Open Firefox.
3. Go to `about:debugging#/runtime/this-firefox`.
4. Click "Load Temporary Add-on".
5. Select `dist/firefox/manifest.json`.

## 설치 Chrome

1. Chrome 또는 Chromium 브라우저를 엽니다.
2. `chrome://extensions`로 이동합니다.
3. 개발자 모드를 켭니다.
4. "압축해제된 확장 프로그램을 로드"를 클릭합니다.
5. 이 프로젝트 폴더를 선택합니다.

## 설치 Firefox

1. 실행합니다:

```sh
node scripts/prepare-firefox.mjs
```

2. Firefox를 엽니다.
3. `about:debugging#/runtime/this-firefox`로 이동합니다.
4. "Load Temporary Add-on"을 클릭합니다.
5. `dist/firefox/manifest.json`을 선택합니다.


## Use

- Click the extension icon, then `Translate / Restore Page`.
- The popup also lets you edit the LM Studio endpoint, model, target language, timeout, auto-translate setting, prompt, display style, and token/performance limits.
- Use `Alt+T` to translate or restore the current page.
- Select text, right-click, then choose `선택한 문장 번역`.
- Turn on domain auto-translate on each site where you want newly opened pages on the same domain to translate automatically.

## 사용

- 확장 아이콘을 클릭한 뒤 `Translate / Restore Page`를 누릅니다.
- 팝업에서 LM Studio 엔드포인트, 모델, 대상 언어, 타임아웃, 자동 번역 설정, 프롬프트, 표시 스타일, 토큰/성능 제한을 변경할 수 있습니다.
- `Alt+T`로 현재 페이지를 번역/복원합니다.
- 텍스트를 선택하고 우클릭한 뒤 `선택한 문장 번역`을 선택합니다.
- 같은 도메인의 새 페이지를 자동 번역하려면 해당 사이트에서 도메인 자동 번역을 켭니다. 다른 도메인은 그 도메인에서 다시 켜야 합니다.

## Notes

This is intentionally small. It avoids PDF, video subtitles, OCR, account systems, telemetry, and service-specific header tricks.

Google Search result titles are handled separately from normal links so the translated title stays beside the original title instead of being pushed above it by Google's result layout. On other sites, short headings are placed inline automatically, while longer headings stay below for readability.

## 참고

이 확장은 의도적으로 작게 유지됩니다. PDF, 비디오 자막, OCR, 계정 시스템, 텔레메트리, 특정 서비스 전용 헤더 트릭은 포함하지 않습니다.

Google 검색 결과 제목은 일반 링크와 분리 처리하여, 번역 제목이 검색 결과 레이아웃 때문에 위로 밀리지 않고 원문 옆에 남도록 합니다. 다른 사이트에서는 짧은 제목은 자동으로 인라인 배치하고, 긴 제목은 가독성을 위해 아래에 배치합니다.
