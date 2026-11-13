# 모델 학습 (개발 PC 전용)

키오스크 PC에는 Python이 필요 없습니다. 여기서 만든 `app/public/model/` 묶음만 앱에 들어갑니다.

## 순서

| 단계 | 명령 | 결과 |
| --- | --- | --- |
| 1 데이터 받기 | `python download.py` | `data/raw/<id>.ndjson`, `data/raw/manifest.json`(출처, 받은 날, 바이트 수, sha256) |
| 2 변환·분리 | `python prepare.py` | `data/prepared/*.npz`, `manifest.json`(세트별 개수, 원본·가공 체크섬), `split_keys.json`(세트별 key_id) |
| 3 학습·내보내기 | `python train.py --version qd20-vN` | `runs/<version>/report.json`, `confusion_test.csv`, `app/public/model/{model.onnx,bundle.json}` |
| 4 교차 검증 데이터 | `python make_fixture.py` | `app/tests/fixtures/raster.json`(전처리 결과와 모델 점수) |

## 데이터

- 출처: Quick, Draw! 단순화 획 데이터(`full/simplified/<분류>.ndjson`), CC BY 4.0
- 분류마다 파일 앞부분 16MB만 받습니다(HTTP Range). 2만~4만 장이 들어 있습니다.
- `recognized: true`인 그림만 쓰고, 같은 `key_id`는 한 번만 씁니다.
- 세트 분리: `sha1(key_id) % 20`이 0이면 시험, 1이면 검증, 나머지는 학습입니다. 같은 그림과 그 증강본은 항상 같은 세트에 들어갑니다.
- 학습 세트는 분류당 최대 15,000장입니다(PRD 최소 5,000장). 검증과 시험은 분류당 940장 이상입니다(PRD 최소 500장).
- 그리는 중간 단계: 학습 세트의 약 20%에 앞부분 획만 남긴 샘플을 더합니다. 검증용 `val_partial`은 앞쪽 절반 획만 남긴 그림이며, 완성 그림 성능(`val`, `test`)과 따로 보고합니다.
- 증강(학습 중에만): 위치 ±10%, 크기 0.85~1.10배, 회전 ±12°.

## 전처리 qd-raster-v1

[rasterize.py](rasterize.py)와 [app/src/preprocess.ts](../app/src/preprocess.ts)가 같은 알고리즘입니다.

1. 전체 경계 상자의 긴 변을 255로 맞추고 왼쪽 위에 붙입니다.
2. 획마다 RDP(epsilon 2) 단순화를 합니다.
3. 28×28 안쪽 24×24에 종횡비를 유지해 가운데 배치합니다.
4. 픽셀 중심에서 가장 가까운 선분까지의 거리 d로 값 `clip(1.4 - d, 0, 1)`을 정합니다.

화면 크기, 그림 위치, 손가락 굵기와 무관하게 같은 그림은 같은 입력이 됩니다.

## 모델

`DoodleNet`: 3×3 합성곱 5층(32-32-64-64-128) + 전역 평균 풀링 + 선형 20. 파라미터 약 14만 개, ONNX 약 0.6MB입니다. 출력에 소프트맥스를 포함해 내보냅니다(입력 `input` [N,1,28,28] 0~1, 출력 `probs` [N,20]).

가장 좋은 가중치는 검증 세트 기준으로 고르고, 시험 세트는 마지막에 한 번만 평가합니다. 성공 기준(점수 0.75, 1·2위 차이 0.20, 유지 600ms)을 바꿀 때도 검증 세트만 봅니다.
