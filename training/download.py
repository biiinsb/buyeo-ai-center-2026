"""Quick Draw 단순화 획 데이터(ndjson)를 분류마다 앞부분만 내려받는다.

    python download.py            # 없는 파일만 받기
    python download.py --force    # 모두 다시 받기
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import urllib.parse
import urllib.request

from config import CLASSES, DOWNLOAD_BYTES_PER_CLASS, RAW_DIR, SOURCE_LICENSE, SOURCE_URL


def fetch(name: str, limit: int) -> bytes:
    url = SOURCE_URL.format(name=urllib.parse.quote(name))
    req = urllib.request.Request(url, headers={"Range": f"bytes=0-{limit - 1}", "User-Agent": "quickdraw-trainer"})
    with urllib.request.urlopen(req, timeout=120) as res:
        body = res.read()
    # 마지막 줄은 잘렸을 수 있으므로 마지막 줄바꿈까지만 쓴다.
    return body[: body.rfind(b"\n") + 1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = RAW_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {"files": {}}

    for class_id, _word, source_name, _level in CLASSES:
        path = RAW_DIR / f"{class_id}.ndjson"
        if path.exists() and not args.force and class_id in manifest["files"]:
            print(f"skip  {class_id}")
            continue
        body = fetch(source_name, DOWNLOAD_BYTES_PER_CLASS)
        path.write_bytes(body)
        manifest["files"][class_id] = {
            "source": SOURCE_URL.format(name=urllib.parse.quote(source_name)),
            "sourceName": source_name,
            "range": f"bytes=0-{DOWNLOAD_BYTES_PER_CLASS - 1} (마지막 줄바꿈까지)",
            "bytes": len(body),
            "lines": body.count(b"\n"),
            "sha256": hashlib.sha256(body).hexdigest(),
            "downloadedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }
        print(f"saved {class_id}: {len(body):,} bytes, {body.count(b'\n'):,} drawings")

    manifest["license"] = SOURCE_LICENSE
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")


if __name__ == "__main__":
    main()
