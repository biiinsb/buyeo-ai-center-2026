# AI 낙서 탐정 — 부여 AI센터 그림 맞히기 키오스크

학생이 터치스크린에 그림을 그리면 센터 PC 안의 AI가 무엇을 그리는지 맞히는 3~5분 체험입니다. 인터넷 없이 동작하며, 학생 이름이나 그림을 저장하지 않습니다.

- 문제: 20개 키워드 중 5개를 무작위로 출제, 문제당 30초
- AI: 20종 그림 분류 CNN(약 14만 파라미터, 0.6MB) 하나를 CPU에서 실행. 제시어는 모델 입력에 넣지 않음
- 모델 qd20-v1 성능(Quick Draw 시험 세트 29,600여 장): Top-1 96.6%, Top-3 99.5%, 가장 낮은 분류 재현율 93.4%(파인애플). 그리는 중간(앞쪽 절반 획) Top-1 83.4%. 실제 초등학생 그림 성능은 현장 파일럿에서 따로 확인해야 합니다.
- 화면: 세로형 1080×1920 터치 전용

기획과 요구사항은 [docs/PRD.md](docs/PRD.md), 센터 PC 검토는 [docs/HARDWARE-ASSESSMENT.md](docs/HARDWARE-ASSESSMENT.md)에 있습니다.

## 센터 키오스크에 설치하기

대상 PC: Intel i3-13100, RAM 8GB, 외장 그래픽카드 없음, Windows 10/11 64비트.

### 방법 1. 설치 파일 (권장)

1. [Releases](https://github.com/biiinsb/buyeo-ai-center-2026/releases)에서 최신 `doodle-detective-…-x64.exe`(설치용) 또는 `…-portable.exe`(설치 없이 실행)를 받습니다.
2. 설치 후 바탕화면의 **AI 낙서 탐정**을 실행하면 전체 화면 키오스크로 열립니다.
3. 설치 뒤에는 인터넷이 필요 없습니다. 모델, 글꼴, 실행 파일이 모두 들어 있습니다.

### 방법 2. 소스에서 실행

Node.js 20 이상이 필요합니다. 설치할 때만 인터넷을 씁니다.

```bat
git clone https://github.com/biiinsb/buyeo-ai-center-2026.git
cd buyeo-ai-center-2026\app
npm ci
npm run kiosk
```

설치 파일을 직접 만들려면 `npm run dist`를 실행합니다(`app/release/`에 생성).

### 운영자 조작

학생 화면에는 관리 기능이 보이지 않습니다. 키보드를 연결해 다음 키를 씁니다.

| 키 | 동작 |
| --- | --- |
| Ctrl+Shift+D | 진단 화면 열기/닫기(버전, 추론 속도, 회차·키워드 집계) |
| Ctrl+Shift+X | 진단 화면이 열린 상태에서 집계 초기화 |
| Ctrl+Shift+R | 앱 새로고침 |
| Ctrl+Shift+Q | 앱 종료 |

**설정 바꾸기:** 설치 폴더(실행 파일 옆)의 `settings.json`을 고친 뒤 앱을 다시 시작합니다. 문제 수, 그림 시간, 자동 넘김 시간, 무조작 복귀 시간 등을 바꿀 수 있습니다. 범위를 벗어난 값은 기본값으로 되돌아가고 진단 화면에 경고가 남습니다.

**Windows 시작 시 자동 실행:** `Win+R` → `shell:startup` 폴더에 바탕화면 바로 가기를 복사합니다.

## 저장소 구조

```
docs/        PRD, 센터 PC 검토
training/    모델 학습(개발 PC 전용, Python)
app/         키오스크 앱(TypeScript, Vite, onnxruntime-web, Electron)
  public/model/   배포용 모델 묶음(model.onnx + bundle.json)
```

## 개발

### 앱

```bash
cd app
npm ci          # onnxruntime WASM 파일을 public/ort/ 로 복사하고 Electron 을 받습니다
npm run dev     # 브라우저 개발 서버 http://localhost:5173 (마우스로도 그릴 수 있음)
npm run check   # 타입 검사 + 테스트
npm run kiosk:window   # Electron 창 모드(개발 도구 사용 가능)
```

`npm run smoke`는 Electron 창을 띄워 실제 마우스 입력으로 한 회차를 진행하고 화면 캡처와 결과를 `smoke-out/`에 남깁니다(학습 데이터 `training/data/raw`가 있어야 함). VS Code 터미널처럼 `ELECTRON_RUN_AS_NODE`가 설정된 곳에서 `npm run kiosk`가 바로 꺼지면 그 변수를 지우고 실행하세요.

Windows에서 테스트가 `Vitest failed to find the current suite`로 실패하면, 경로의 드라이브 문자를 대문자로 바꿔 실행하세요(`C:\…`, `c:\…` 아님).

### 모델 다시 학습하기

```bash
cd training
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python download.py      # Quick Draw 20종, 분류당 앞부분 16MB
.venv\Scripts\python prepare.py       # 28x28 변환, 학습/검증/시험 분리
.venv\Scripts\python train.py --version qd20-v2
.venv\Scripts\python make_fixture.py  # 앱 교차 검증 데이터 갱신
cd ..\app && npm run check
```

`train.py`가 `app/public/model/`에 `model.onnx`와 `bundle.json`(라벨 순서, 전처리 규칙, 성공 기준, 체크섬)을 씁니다. 앱은 시작할 때 체크섬, 출력 클래스 수, 라벨 수, 전처리 규칙을 확인하고, 맞지 않으면 체험을 열지 않습니다. 학습 보고서와 혼동 행렬은 `training/runs/<version>/`에 남습니다.

**전처리는 두 곳에 같은 알고리즘으로 있습니다:** `training/rasterize.py`와 `app/src/preprocess.ts`. 한쪽을 고치면 다른 쪽도 고치고, `make_fixture.py`를 다시 실행한 뒤 앱 테스트를 통과시켜야 합니다.

## 라이선스와 출처

- 학습 데이터: [The Quick, Draw! Dataset](https://github.com/googlecreativelab/quickdraw-dataset), Google, CC BY 4.0
- 실행 라이브러리: ONNX Runtime Web(MIT), Electron(MIT)

원문은 [app/public/licenses/](app/public/licenses/)에 있고 배포물에도 포함됩니다.
