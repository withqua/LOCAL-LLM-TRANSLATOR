# AGENTS.md

이 저장소에서 작업하는 AI 에이전트와 기여자를 위한 가이드입니다.

## 스택 및 플랫폼

- 언어: 순수 JavaScript, HTML, CSS.
- 플랫폼: Chrome/Chromium 및 Firefox 확장 프로그램, Manifest V3.
- 런타임 영역:
  - `background.js`: MV3 백그라운드 로직. Chrome은 서비스 워커로 로드하고, Firefox는 `manifest.firefox.json`을 통해 백그라운드 스크립트로 로드합니다.
  - `content.js`와 `content.css`: 페이지에 주입되는 번역 UI.
  - `popup.html`, `popup.js`, `popup.css`: 확장 프로그램 팝업.
- 로컬 API 대상: OpenAI 호환 LM Studio 서버, 기본값은 `http://localhost:1234/v1/chat/completions`.
- 지원 브라우저: Manifest V3를 지원하는 Chrome/Chromium과, Firefox 전용 매니페스트를 사용하는 Firefox.

변경 범위와 정당성이 명확하지 않다면 프레임워크, 번들러, 트랜스파일러, TypeScript 마이그레이션을 도입하지 마세요.

## 디렉터리 구조

이 프로젝트는 의도적으로 평평한 구조입니다.

- `manifest.json`: 확장 메타데이터, 권한, 명령, MV3 진입점.
- `manifest.firefox.json`: `background.scripts`를 사용하는 Firefox 전용 매니페스트.
- `background.js`: 설정, 동적 콘텐츠 스크립트 등록, 컨텍스트 메뉴, 키보드 명령, 요청 취소, LM Studio API 호출.
- `content.js`: 텍스트 수집, 페이지 번역 상태, DOM 삽입, SPA 내비게이션 처리, 선택 버블, 런타임 메시지 처리.
- `content.css`: 번역된 페이지에 주입되는 스타일.
- `popup.html`: 팝업 마크업 בלבד.
- `popup.js`: 팝업 이벤트 처리, 설정 로드/저장, 권한 요청, 활성 탭 콘텐츠 스크립트 주입.
- `popup.css`: 팝업 스타일만 담당.
- `README.md`: 사용자용 설치 및 사용 문서.
- `scripts/prepare-firefox.mjs`: Firefox 매니페스트를 `manifest.json`으로 이름 변경한 `dist/firefox/`를 생성.
- `LICENSE`: 라이선스 텍스트.

프로젝트가 커지면 `src/background/`, `src/content/`, `src/popup/`, `docs/`처럼 책임 단위의 작은 폴더를 선호하세요. 구조를 맞추기 위한 분리는 피하고, 소유권과 테스트 용이성이 개선될 때만 분리하세요.

## 변경 불가 제약

- 이 저장소에는 현재 패키지 매니저나 빌드 도구가 없습니다. 작업 요구가 명시되지 않으면 도입하지 마세요.
- 나중에 패키지 도구를 도입하더라도, 같은 변경에서 문서화된 프로젝트 결정을 따르고 해당 잠금 파일만 커밋하세요.
- `.git/`을 편집하지 마세요.
- 라이선스 변경 요청이 아닌 한 `LICENSE`를 수정하지 마세요.
- 텔레메트리, 원격 분석, 계정 시스템, 서드파티 네트워크 호출을 추가하지 마세요.
- 호스트 권한은 좁게 유지하세요. `host_permissions` 또는 정적 `content_scripts`에서 `<all_urls>`를 복원하지 마세요.
- 번역 모델 출력에 `innerHTML`로 HTML을 주입하지 마세요. `textContent`, `createTextNode`, 구조화된 DOM API를 사용하세요.
- 사용자 프라이버시를 보호하세요. 명시적인 제품 결정이 없으면 페이지 텍스트는 설정된 로컬 번역 엔드포인트로만 전송되어야 합니다.

## 계획 규칙

작고 경계가 뚜렷한 변경은 바로 작업하세요:

- 원인이 명확한 버그 수정.
- 카피 또는 CSS 조정.
- 작은 권한/설정 변경.
- 하나의 런타임 영역 내부에 국한된 리팩터링.

제품 동작, 권한, 데이터 흐름, 아키텍처에 영향을 주는 변경은 구현 전에 짧은 1-Pager를 작성하세요. 포함 항목:

- 문제와 사용자 영향.
- 제안 동작.
- 권한/프라이버시 영향.
- 수정 파일.
- 롤아웃 및 검증 계획.

새 빌드 도구, 새 의존성, TypeScript 마이그레이션, Rust/네이티브 컴포넌트, 영속 저장 스키마 변경, 또는 광범위한 UI 변경에는 1-Pager를 사용하세요.

## 코드 편집 전

- 인접한 코드를 먼저 읽고, 호출 지점과 상태 전이를 확인하세요.
- 런타임 경계를 식별하세요: 팝업, 백그라운드, 콘텐츠 스크립트.
- 이름과 제어 흐름에서 의도가 드러나는 코드를 선호하세요.
- 상태 변화와 부수 효과가 명확해지도록 함수는 충분히 작게 유지하세요.
- 작업이 명시적으로 변경하지 않는 한 기존 동작을 유지하세요.
- 기능 작업과 광범위한 리팩터링을 섞지 마세요.
- 깊은 중첩보다 이른 반환을 선호하세요.
- 브라우저 확장 동작, 권한 제약, 레이스 컨디션처럼 비직관적인 경우에만 주석을 추가하세요.

## 런타임 경계

- 백그라운드는 확장 수준 상태, 스토리지 정규화, 선택적 호스트 권한, 동적 콘텐츠 스크립트 등록, 컨텍스트 메뉴, 명령, API fetch, 캐싱, 취소를 소유합니다.
- Chrome 콜백 API와 Firefox `browser.*` Promise API 모두에서 동작해야 하는 호출은 기존 `extensionApi` 호환 래퍼를 통해야 합니다.
- 콘텐츠 스크립트는 페이지 로컬 상태, DOM 읽기/쓰기, 텍스트 선택 UI, 라우트 감시, 번역 배치를 소유합니다.
- 팝업은 사용자 입력, 활성 탭 동작, 명시적 권한 프롬프트, 설정 표시를 소유합니다.

TypeScript를 도입하는 경우:

- 공용 타입은 `src/shared/`에 둘 수 있습니다.
- 팝업/콘텐츠/백그라운드는 서로의 런타임 전용 API를 임포트하면 안 됩니다.
- 브라우저 API 래퍼는 얇고 타이핑된 형태를 유지하세요.

Rust 또는 네이티브 브리지를 도입하는 경우:

- Rust는 CPU 집약적이며 결정적인 로직만 소유합니다.
- JavaScript는 브라우저 확장 API, DOM, 권한, 사용자 상호작용을 소유합니다.
- 브리지 경계는 버전이 있는 스키마를 가진 JSON 호환 메시지를 사용해야 합니다.

## 구조화된 API

구문이 있는 항목은 문자열 결합 대신 구조화된 API를 사용하세요:

- 경로: 도구가 도입되면 `path.join`, `URL`, 또는 브라우저 URL API를 사용합니다.
- URL과 origin: `new URL()`과 브라우저 매치 패턴 헬퍼를 사용합니다.
- JSON: `JSON.parse`와 `JSON.stringify`를 사용하고, JSON 문자열을 직접 만들지 마세요.
- 셸 명령: 이스케이프되지 않은 문자열을 합치지 말고 스크립트에서 인자를 배열로 전달하세요.
- DOM: `createElement`, `append`, `replaceChildren`, `textContent`, attributes를 사용합니다.
- 확장 메시징: 명시적인 `type` 필드를 가진 객체를 전송하세요.

## 크기 및 복잡도 한도

이 항목들은 목표이며, 요란한 재작성의 변명이 아닙니다.

- 파일 길이: 500줄 미만을 선호. 일관된 경계가 있으면 800줄 초과 시 분리하세요.
- 함수 길이: 60줄 미만을 선호. 100줄 초과 시 재검토.
- 파라미터: 3개 이하 선호. 4개 초과는 옵션 객체 사용.
- 중첩 깊이: 3단계 이하 선호.
- 사이클로매틱 복잡도: 함수당 10 미만 선호.
- 메시지 페이로드: 런타임 메시지는 작고 명시적으로 유지하고, 번역 텍스트 배치를 제외한 DOM 파생 대량 데이터 전달은 피하세요.
- 배치 크기: 로컬 모델과 MV3 서비스 워커가 긴 요청에서 멈출 수 있으므로 기본값은 보수적으로 유지하세요.

## 업스트림 및 로컬 코드

현재는 벤더된 업스트림 코드가 없습니다.

업스트림 코드나 생성 자산을 추가하는 경우:

- `vendor/` 또는 `generated/` 같은 명확한 디렉터리 아래에 둡니다.
- 일반적인 기능 작업 중에는 해당 디렉터리를 읽기 전용으로 취급합니다.
- 가능하면 로컬 패치를 업스트림 파일 밖에 유지합니다.
- 예: `scripts/update-vendor.mjs` 같은 업데이트 스크립트를 추가합니다.
- 소스 버전, 실행한 명령, 변경 파일, 수동 패치를 기록하는 업데이트 체크리스트를 추가합니다.

업스트림 코드를 업데이트하기 전에:

- 이전/신규 업스트림 버전을 기록합니다.
- 깨끗한 작업 트리에서 업데이트 스크립트를 실행합니다.
- 로컬 기능 작업과는 별도로 diff를 리뷰합니다.
- 아래의 전체 검증 흐름을 실행합니다.

## 검증 흐름

이 저장소에는 현재 패키지 스크립트가 없습니다. 코드 변경 후 다음 명령을 실행하세요:

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

수동 브라우저 점검:

1. `chrome://extensions`에서 이 폴더의 압축 해제 확장을 로드합니다.
2. 일반적인 `http` 또는 `https` 페이지를 엽니다.
3. 확장을 클릭해 페이지 번역을 실행합니다.
4. 현재 도메인 자동 번역을 활성화하고 권한 프롬프트를 수락합니다.
5. 같은 도메인의 다른 페이지로 이동해 자동 번역이 실행되는지 확인합니다.
6. 다른 도메인으로 이동해 활성화 전에는 자동 번역이 실행되지 않는지 확인합니다.
7. 텍스트를 선택하고 우클릭해서 선택 번역이 동작하는지 확인합니다.
8. 현재 도메인 자동 번역을 비활성화하고, 해당 도메인의 새 페이지에서 더 이상 자동 번역이 실행되지 않는지 확인합니다.
9. Firefox에서는 `about:debugging#/runtime/this-firefox`에서 `dist/firefox/manifest.json`을 로드한 뒤 동일한 점검을 반복합니다.

나중에 패키지 도구가 추가되면, 선택한 패키지 매니저에 맞는 동등한 스크립트를 정의하세요:

```sh
<package-manager> lint
<package-manager> test
<package-manager> build
```

스택, 권한 모델, 디렉터리 구조, 검증 명령이 바뀌면 이 파일을 업데이트하세요.
