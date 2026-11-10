# Chat Site

디스코드 스타일의 채팅 앱입니다. 프런트엔드는 **GitHub Pages**(정적 호스팅)에, 실시간 서버는 **Node.js + Socket.IO + MongoDB**로 따로 배포합니다.
서버나 MongoDB에 연결할 수 없으면 **자동으로 이 기기(IndexedDB)에 저장**하고, 다시 연결되면 서버로 동기화합니다.

## 주요 기능

| 구분 | 내용 |
| --- | --- |
| 로그인 | Google, Apple, 게스트. 메시지와 프로필에 로그인 방식 배지(Google / Apple / 게스트)가 표시됩니다. |
| 프로필 | 프로필 사진, 닉네임 (편집 가능), 로그인 방식, 접속 상태, 가입일 |
| 방 구조 | 채팅방 · 통화방 · 폴더. 폴더 안에 폴더를 무한히 넣을 수 있고, 드래그(데스크톱) 또는 “이동” 메뉴(모바일)로 정리 |
| 메시지 | 이름이 위, 그 아래 프로필 사진, 사진 옆에 내용이 오는 디스코드식 배치. 같은 사람이 이어서 보낸 메시지는 묶어서 표시 |
| 첨부 | 이미지 · 동영상 · 오디오 · 모든 파일 (드래그 앤 드롭, 붙여넣기, 최대 10개) |
| 파일 유효기간 | 업로드 후 일정 기간(기본 72시간)만 내려받을 수 있습니다. 기간이 지나면 서버에서 삭제되고, **기기에 저장된 사본이 있으면 보여주지만 다시 내려받을 수는 없습니다.** |
| 고정 | 메시지 고정 → 채팅방 상단 📌 버튼으로 고정된 메시지를 모아 보고 원래 위치로 이동 |
| 그 외 | 답장, 수정, 삭제, 이모지 반응, @멘션(자동완성·강조·알림), 마크다운(`**굵게**` `*기울임*` `__밑줄__` `~~취소선~~` `\|\|스포일러\|\|` `` `코드` `` 코드블록, 인용), 검색, 입력 중 표시, 읽지 않은 메시지 배지, 날짜 구분선, 이전 메시지 무한 스크롤, 멤버 목록·접속 상태, 브라우저 알림, 다크/라이트 테마, 빠른 이동(Ctrl/⌘+K), PWA(홈 화면에 추가) |
| 통화방 | WebRTC 음성 · 영상 · 화면 공유, 음소거 · 소리 끄기, 말하는 사람 표시, 사이드바에 통화 참여자 표시 |
| 모바일 | 슬라이드 사이드바(스와이프), 길게 눌러 메시지 메뉴(바텀시트), 안전 영역(노치) 대응, 16px 입력창(확대 방지) |

### v1.0 — Beyond Chat

**자세한 내용은 [FEATURES.md](FEATURES.md#v10--beyond-chat) 에 있습니다.**

- **1:1 개인 메시지** — 두 사람만 보는 대화(서버에서 접근 제어), 최근 대화 순 목록, `/dm`
- **통합 탐색 · 분할 화면 · 멀티 패널** — Ctrl/⌘+Shift+F 로 방·사람·메시지·파일 검색, 두 방 나란히 보기, 멤버 목록 항상 표시
- **채팅 사용성** — 답장 탐색, 여러 메시지 선택·삭제(실행 취소), 안 읽은 곳으로 이동, 사람별 필터, 방별 검색 기록, 수정 전후 비교, 방 보관
- **내 보관함** — 만료 없는 개인 파일 공간 (첨부를 만료 전에 보관)
- **안정성 · 보안** — 중복 전송 방지, 수정 충돌 처리, 서버 상태 화면, 세션 자동 갱신, 데이터 복구·백업, 파일 무결성(SHA-256), 사용자별 요청 제한, 파일 보안 헤더, 자동 오류 보고
- **화면** — 빠른 설정, 사이드바 구성, 패널 너비 끌어서 조절, 메시지 간격·화면 배율, 저사양 기기 자동 최적화, 모바일 제스처(밀어서 답장 · 뒤로 가기), 스켈레톤 로딩
- **AI 도우미 (선택)** — 서버에 `ANTHROPIC_API_KEY` 가 있으면 대화 요약 · 대화 기록 질문
- **자동화 테스트** — 서버 통합 테스트 + 브라우저 테스트 (GitHub Actions)

### 추가 기능 100가지 · 코드 실행

**전체 목록과 사용법은 [FEATURES.md](FEATURES.md) 에 있습니다.** 주요 기능:

- **코드 실행** — 채팅의 ` ```js `, ` ```python `, ` ```html ` 코드 블록에 ▶ 실행 버튼. 결과(콘솔 출력·반환값·오류 줄 번호)를 바로 보고 채팅으로 보낼 수 있습니다.
  코드는 `sandbox="allow-scripts"` iframe(출처 없음) 안의 Worker 에서 실행되므로 이 사이트의 로그인 토큰·저장된 대화·쿠키에 접근할 수 없고, 무한 루프는 시간 제한(JS 10초, Python 60초)이나 **중지** 버튼으로 멈춥니다.
  Python 은 [Pyodide](https://pyodide.org) 를, 구문 강조는 highlight.js, 수식은 KaTeX 를 필요할 때만 CDN 에서 불러옵니다.
- **서식** — 제목, 목록, 체크리스트, 표, 수식, 색상 견본, 서식 단축키
- **메시지** — 투표, 전달, 북마크, 수정 기록, 메시지 링크, 읽어주기, 음성 입력, 음성 메시지, 위치, 스포일러 첨부, YouTube 미리보기
- **명령어** — `/shrug /me /roll /flip /calc /remind /poll /nick /status /topic /spoiler /code /help`, `:이모지:` 자동완성
- **방** — 즐겨찾기, 방 이모지·폴더 색, 방별 알림, 공지 전용 방, 슬로우 모드, 방 정보, 채팅 내보내기
- **프로필** — 상태 메시지, 자기소개, 배너 색, 온라인/자리 비움/방해 금지/오프라인으로 표시, 메모, 차단
- **검색** — `from:` `has:` `before:` `after:` `during:` `in:all` 필터, 받은 멘션, 미디어·파일·링크 모아보기
- **통화** — 통화 시간, 참가자별 볼륨, 장치 선택, 눌러서 말하기, 입장·퇴장 효과음

### 권한

| 동작 | Google / Apple | 게스트 |
| --- | :---: | :---: |
| 채팅방에서 메시지·파일 보내기, 자기 메시지 수정·삭제 | ✅ | ✅ |
| 채팅방 · 통화방 · 폴더 만들기 / 이름 변경 / 이동 / 삭제 | ✅ | ❌ |
| 메시지 고정, 반응, 투표 만들기·참여, 다른 사람 메시지 삭제 | ✅ | ❌ |
| 공지 전용 방에 글쓰기 | ✅ | ❌ |
| 코드 실행, 북마크, 전달, 검색, 개인 설정 | ✅ | ✅ |
| 통화 참여 | ✅ | ❌ |
| 1:1 개인 메시지 | ✅ | ✅ |
| 내 보관함 (영구 파일), AI 도우미 | ✅ | ❌ |

1:1 대화에서는 관리 권한이 있어도 상대의 메시지를 지울 수 없습니다.

권한은 `client/js/permissions.js` 와 `server/src/permissions.js` 에서 바꿀 수 있습니다 (두 파일을 같게 유지하세요 — 다르면 `npm test` 가 실패합니다). 서버도 같은 규칙으로 검사합니다.

## 앱으로 설치 (모바일 · PC)

설치하면 홈 화면·바탕화면·시작 메뉴에서 주소창 없이 앱처럼 열리고, 아이콘에 안 읽은 메시지 수가 표시되며, 오프라인에서도 열립니다.
사이드바 위쪽 ⤓ 버튼, 로그인 화면의 “앱으로 설치”, 설정(⚙) → 앱으로 설치 에서 할 수 있습니다.

| 환경 | 방법 |
| --- | --- |
| Android Chrome · 삼성 인터넷 · PC Chrome · Edge · Whale | 설치 버튼 → 바로 설치 창 |
| iPhone / iPad (Safari) | 공유 □↑ → 홈 화면에 추가 (앱 안에서 그림 안내) |
| 카카오톡 · 네이버 앱 안 브라우저 | 설치 불가 → “기본 브라우저로 열기” 버튼으로 이동 후 설치 |
| PC Safari | 파일 → Dock에 추가 |
| PC Firefox | 앱 설치 미지원 → 주소창 🔒 아이콘을 바탕화면으로 끌어 바로가기 |

앱 아이콘을 길게 누르면(또는 오른쪽 클릭) **받은 멘션 · 메시지 검색 · 저장한 메시지** 바로가기가 나옵니다.

## 구조

```
client/                 GitHub Pages 에 배포되는 정적 앱 (빌드 과정 없음)
  env.js                배포 설정 (서버 주소, Google/Apple 클라이언트 ID 등)
  js/data.js            데이터 계층: 서버 ↔ 기기 저장소 전환, outbox 동기화
  js/db.js              IndexedDB 저장소
  js/call.js            WebRTC 통화
  js/errorlog.js        자동 오류 기록 · 보고
  js/ui/*.js            화면 구성 요소
server/                 Socket.IO + MongoDB 서버 (Koyeb 에 Dockerfile 로 배포)
  src/index.js          HTTP API · 실시간 이벤트 · 권한 검사
  src/ratelimit.js      요청 제한
  src/memdb.js          메모리 DB (MONGODB_URI=memory, 개발 · 테스트용)
  src/ai.js             AI 도우미 (선택)
  test/                 단위 · 통합 · 브라우저 테스트
.github/workflows/      GitHub Pages 자동 배포, 테스트
```

### 저장 방식 (MongoDB 장애 대비)

1. 모든 데이터는 기기의 IndexedDB 에도 저장됩니다. 서버에 연결되어 있으면 서버(MongoDB)가 기준입니다.
2. 서버 주소가 없거나, 서버가 꺼져 있거나, **서버는 살아 있지만 MongoDB 연결이 끊긴 경우** 모두 자동으로 “기기에 저장” 모드로 바뀝니다. 화면 위쪽에 상태 배너가 표시됩니다.
3. 그동안 한 작업(메시지, 파일, 방 만들기 등)은 outbox 에 순서대로 쌓이고, 다시 연결되면 자동으로 서버에 보내집니다.
4. 서버 주소를 비워 두면 서버 없이 **로컬 모드**로 동작합니다 (한 기기에서만, 탭 사이 동기화 지원).

## 빠른 시작 (내 컴퓨터)

```bash
# 1) 클라이언트만 (로컬 모드)
cd client && python3 -m http.server 5173
# http://localhost:5173 접속 → 게스트로 입장

# 2) 서버까지
cd server
cp .env.example .env      # MONGODB_URI, JWT_SECRET 등 입력
npm install
npm start                  # http://localhost:8080
# 앱의 설정(⚙) → 서버 주소에 http://localhost:8080 입력

# MongoDB 없이 서버 띄우기 (재시작하면 데이터가 사라짐)
npm run dev:memory
```

## 테스트

```bash
cd server
npm test                 # 단위 + 통합 테스트 (메모리 DB 로 서버를 띄워 실제 Socket.IO 로 확인)
# 브라우저 테스트 (Playwright + Chromium 필요)
npm i --no-save playwright && npx playwright install chromium
npm run test:e2e         # 스크린샷: npm run test:e2e -- shots
```

GitHub 에 push 하거나 PR 을 열면 `.github/workflows/test.yml` 이 두 테스트를 자동으로 실행합니다.

## 배포

### 1. MongoDB Atlas
1. [MongoDB Atlas](https://www.mongodb.com/atlas)에서 무료 클러스터를 만듭니다.
2. Database Access 에서 사용자를 만들고, Network Access 에 서버 IP(또는 `0.0.0.0/0`)를 허용합니다.
3. Connect → Drivers 의 연결 문자열을 `MONGODB_URI` 로 사용합니다.

### 2. 서버 (Koyeb)
1. [Koyeb](https://app.koyeb.com) 에서 **Create Service → GitHub** 를 선택하고 `ish0503/chat_site` 저장소, `main` 브랜치를 고릅니다.
2. **Builder** 는 **Dockerfile** 을 선택하고, **Work directory** 를 `server` 로 지정합니다 (`server/Dockerfile` 사용).
3. **Exposed ports**: `8000` / HTTP, 경로 `/`. **Health checks**: HTTP, 포트 `8000`, 경로 `/api/health`.
4. **Environment variables** 에 다음을 넣습니다. 비밀 값(`MONGODB_URI`, `JWT_SECRET`)은 *Secret* 으로 만들어 연결하세요.

   | 이름 | 값 |
   | --- | --- |
   | `MONGODB_URI` | Atlas 연결 문자열 (Secret) |
   | `JWT_SECRET` | 길고 무작위인 문자열, 예: `openssl rand -hex 32` (Secret) |
   | `MONGODB_DB` | `chat_site` |
   | `ALLOWED_ORIGINS` | `https://ish0503.github.io` |
   | `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID |
   | `APPLE_CLIENT_ID` | Apple Services ID |
   | `FILE_TTL_HOURS` | `72` |
   | `MAX_UPLOAD_MB` | `25` |
   | `STORAGE_QUOTA_MB` | 내 보관함 사용자당 용량, 기본 `100` |
   | `CALL_MAX_PARTICIPANTS` | 통화방 최대 인원, 기본 `8` |
   | `ANTHROPIC_API_KEY` | (선택) AI 도우미. 비우면 꺼짐 (Secret) |
   | `AI_MODEL` | (선택) 기본 `claude-opus-5-5` |
   | `TRUST_PROXY` | (선택) 앞단 프록시 수, 기본 `1` (요청 제한에 쓰는 접속 IP 판단용) |

5. **Instance** 는 무료(Free) 또는 원하는 크기를 고르고 배포합니다. 인스턴스는 **1개**로 두세요 (통화 시그널링·접속 상태를 메모리에 두기 때문에 여러 개로 늘리면 서로 연결되지 않습니다).
6. 배포된 주소(예: `https://chat-site-xxxx.koyeb.app`)를 GitHub 변수 `SERVER_URL` 에 넣습니다. Koyeb 주소는 HTTPS 이고 WebSocket 을 지원합니다.
7. MongoDB Atlas 의 Network Access 에는 `0.0.0.0/0` 을 허용해야 합니다 (Koyeb 의 나가는 IP 가 고정되지 않음).

> Koyeb 무료 인스턴스는 일정 시간 요청이 없으면 잠들 수 있습니다. 그동안 앱은 자동으로 “기기에 저장” 모드로 동작하고, 서버가 깨어나면 동기화됩니다.

### 3. GitHub Pages (클라이언트)
1. 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 바꿉니다.
2. **Settings → Secrets and variables → Actions → Variables** 에 다음 값을 추가합니다 (공개되는 값만):
   - `SERVER_URL` — 서버 주소
   - `GOOGLE_CLIENT_ID` — Google OAuth 클라이언트 ID
   - `APPLE_CLIENT_ID` — Apple Services ID
   - (선택) `APP_NAME`, `APPLE_REDIRECT_URI`, `FILE_TTL_HOURS`, `MAX_UPLOAD_MB`
3. `main` 브랜치에 push 하면 `.github/workflows/deploy-pages.yml` 이 `client/` 를 배포합니다. (Actions 탭에서 수동 실행도 가능)
   - 앱 주소: `https://ish0503.github.io/chat_site/`
   - Source 를 **Deploy from a branch** (`main` / root) 로 두어도 동작합니다. 루트의 `index.html` 이 `client/` 로 이동시키며, 이때 앱 주소는 `https://ish0503.github.io/chat_site/client/` 가 됩니다. 단, 이 방식에서는 저장소 Variables 가 적용되지 않으므로 `client/env.js` 를 직접 수정해야 합니다.

변수를 쓰지 않고 `client/env.js` 를 직접 수정해도 됩니다.

### 4. Google 로그인
1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 사용자 인증 정보 → **OAuth 클라이언트 ID**(웹 애플리케이션)를 만듭니다.
2. **승인된 JavaScript 원본**에 `https://ish0503.github.io` (로컬 테스트 시 `http://localhost:5173`)를 추가합니다.
3. 클라이언트 ID 를 클라이언트(`GOOGLE_CLIENT_ID` 변수)와 서버(`GOOGLE_CLIENT_ID` 환경변수) 양쪽에 넣습니다.

### 5. Apple 로그인
Apple Developer Program(유료) 계정이 필요합니다.
1. Certificates, Identifiers & Profiles → Identifiers 에서 App ID 를 만들고 *Sign in with Apple* 을 켭니다.
2. **Services ID** 를 만들고 *Sign in with Apple* 설정에서 도메인 `ish0503.github.io` 와 Return URL(`https://ish0503.github.io/chat_site/`)을 등록합니다.
3. Services ID 를 클라이언트(`APPLE_CLIENT_ID`)와 서버(`APPLE_CLIENT_ID`) 양쪽에 넣습니다. 리디렉트 주소가 다르면 `APPLE_REDIRECT_URI` 로 지정하세요.

서버는 Google/Apple 의 ID 토큰 서명을 공개키(JWKS)로 검증한 뒤 자체 세션 토큰(30일)을 발급합니다. 클라이언트 ID 가 없으면 해당 로그인 버튼은 비활성화되고 게스트 로그인만 가능합니다.

## 참고 / 한계
- **통화**는 서버(시그널링)에 연결되어 있을 때만 됩니다. 참가자끼리 직접 연결(mesh)하므로 4~6명 정도에 적합합니다. 인원이 늘면 영상 화질을 자동으로 낮추고, 최대 인원은 `CALL_MAX_PARTICIPANTS` 로 정합니다 (더 큰 통화는 SFU 미디어 서버가 필요). 회사망 등 일부 네트워크에서는 TURN 서버가 필요할 수 있습니다 (`client/env.js` 에 `ICE_SERVERS` 로 추가).
- 브라우저에서 기기 사본을 지우면(사이트 데이터 삭제, 설정의 “파일 캐시 비우기”) 만료된 파일은 다시 볼 수 없습니다.
- 첨부파일은 MongoDB GridFS 에 저장됩니다. Atlas 무료 등급은 512MB 이므로 `FILE_TTL_HOURS`, `MAX_UPLOAD_MB`, `STORAGE_QUOTA_MB`(보관함은 만료되지 않음)를 적절히 조절하세요.
- 서버는 접속 상태 · 통화 정보를 메모리에 두므로 인스턴스를 1개로 유지하세요. 서버 상태는 앱의 ☁ 아이콘(서버 상태)이나 `GET /api/status`(로그인 필요)로 볼 수 있습니다.
- 자동 오류 보고는 MongoDB `errors` 컬렉션에 30일 동안 보관됩니다 (메시지 내용 · 로그인 토큰은 보내지 않음, 설정에서 끌 수 있음).
