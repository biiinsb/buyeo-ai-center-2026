"""문제은행과 데이터 준비 설정. PRD '문제은행' 표와 1:1로 대응한다."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PREPARED_DIR = DATA_DIR / "prepared"
RUNS_DIR = ROOT / "runs"
APP_MODEL_DIR = ROOT.parent / "app" / "public" / "model"

# (모델 클래스 ID, 학생용 키워드, Quick Draw 원본 분류명, 난도 참고)
# 순서는 모델 출력 인덱스다. 바꾸면 모델을 다시 학습하고 번들 버전을 올린다.
CLASSES = [
    ("strawberry", "딸기", "strawberry", "입문"),
    ("mushroom", "버섯", "mushroom", "입문"),
    ("grapes", "포도", "grapes", "입문"),
    ("ice_cream", "아이스크림", "ice cream", "입문"),
    ("umbrella", "우산", "umbrella", "쉬움"),
    ("pineapple", "파인애플", "pineapple", "쉬움"),
    ("hot_air_balloon", "열기구", "hot air balloon", "쉬움"),
    ("snail", "달팽이", "snail", "쉬움"),
    ("rabbit", "토끼", "rabbit", "보통"),
    ("penguin", "펭귄", "penguin", "보통"),
    ("guitar", "기타", "guitar", "보통"),
    ("octopus", "문어", "octopus", "보통"),
    ("sea_turtle", "바다거북", "sea turtle", "도전"),
    ("elephant", "코끼리", "elephant", "도전"),
    ("giraffe", "기린", "giraffe", "도전"),
    ("firetruck", "소방차", "firetruck", "도전"),
    ("helicopter", "헬리콥터", "helicopter", "어려움"),
    ("crocodile", "악어", "crocodile", "어려움"),
    ("bicycle", "자전거", "bicycle", "어려움"),
    ("kangaroo", "캥거루", "kangaroo", "최종 도전"),
]

CLASS_IDS = [c[0] for c in CLASSES]

SOURCE_URL = "https://storage.googleapis.com/quickdraw_dataset/full/simplified/{name}.ndjson"
SOURCE_LICENSE = "Quick, Draw! Dataset by Google, CC BY 4.0"

# 분류마다 파일 앞부분만 받는다(HTTP Range). 원본 파일은 국가·시간이 섞여 있다.
DOWNLOAD_BYTES_PER_CLASS = 16 * 1024 * 1024

# PRD 최소 기준: 학습 5,000 / 검증 500 / 시험 500. 여유 있게 잡는다.
MAX_TRAIN_PER_CLASS = 15000
MIN_TRAIN_PER_CLASS = 5000
MIN_EVAL_PER_CLASS = 500

# key_id 해시로 세트를 나눈다. 같은 그림은 항상 같은 세트에 들어간다.
SPLIT_MODULO = 20  # 0 -> test, 1 -> val, 나머지 -> train

# 그리는 중간 단계를 흉내 낸 '앞부분 획' 샘플 비율(학습 세트에만 추가).
PARTIAL_TRAIN_FRACTION = 0.2

# PRD '실시간 추론과 성공 조건' 초기값. 검증 세트로만 조정한다.
SUCCESS_RULE = {"minScore": 0.75, "minMargin": 0.20, "holdMs": 600}
