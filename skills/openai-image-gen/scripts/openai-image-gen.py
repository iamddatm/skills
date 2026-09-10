#!/usr/bin/env python3
"""openai-image-gen: text-to-image (gen) / image-to-image (edit) via any
OpenAI-compatible /v1/images gateway (new-api / sub2api / OpenAI direct).
Stdlib only, Python >= 3.9. Config priority: CLI flags > env vars > <skill-dir>/.env"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = SKILL_DIR / ".env"
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def load_env_file(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


ENV = load_env_file(ENV_FILE)


def pick(cli_val, name: str, default: str = "") -> str:
    return cli_val or os.environ.get(name) or ENV.get(name) or default


def to_image_ref(spec: str, label: str) -> dict:
    # local file -> data URL (OpenAI edits JSON accepts image_url only)
    if re.match(r"^(https?|data):", spec, re.I):
        return {"image_url": spec}
    p = Path(spec).resolve()
    if not p.is_file():
        die(f"{label} file not found: {p}")
    mime = MIME.get(p.suffix.lower())
    if not mime:
        die(f"{label} unsupported extension (png/jpg/jpeg/webp/gif): {p}")
    return {"image_url": f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"}


def post(url: str, key: str, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    try:
        # no timeout: high-quality large images can take minutes, bounded by agent-side terminal timeout
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        die(f"request failed: {e} (check BASE_URL or network/proxy)")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="openai-image-gen", description="Text-to-image / image-to-image via any OpenAI-compatible /v1/images gateway")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("gen", "edit"):
        sp = sub.add_parser(name)
        sp.add_argument("--prompt", required=True)
        sp.add_argument("--model")
        sp.add_argument("--size")
        sp.add_argument("--quality")
        sp.add_argument("--n", type=int)
        sp.add_argument("--out")
        sp.add_argument("--out-dir", dest="out_dir")
        sp.add_argument("--base-url", dest="base_url")
        sp.add_argument("--api-key", dest="api_key")
        if name == "edit":
            sp.add_argument("--image", action="append", required=True, help="reference image: local file or http(s) URL, repeatable")
            sp.add_argument("--mask", help="mask image: local file or http(s) URL")
    return ap


def main() -> None:
    a = build_parser().parse_args()

    base = pick(a.base_url, "IMGAPI_BASE_URL").rstrip("/")
    key = pick(a.api_key, "IMGAPI_API_KEY")
    model = pick(a.model, "IMGAPI_MODEL", "gpt-image-2")
    if not base or not key:
        die(f"IMGAPI_BASE_URL / IMGAPI_API_KEY missing: set --base-url/--api-key or env vars, or write {ENV_FILE}")

    endpoint = "/v1/images/generations" if a.cmd == "gen" else "/v1/images/edits"
    payload = {"model": model, "prompt": a.prompt}
    if a.size:
        payload["size"] = a.size
    if a.quality:
        payload["quality"] = a.quality
    if a.n:
        payload["n"] = a.n
    if a.cmd == "edit":
        payload["images"] = [to_image_ref(s, "--image") for s in a.image]
        if a.mask:
            payload["mask"] = to_image_ref(a.mask, "--mask")

    status, text = post(base + endpoint, key, payload)
    if status >= 400:
        die(f"HTTP {status}\n{text[:2000]}")
    try:
        data = json.loads(text)["data"]
    except Exception:
        die(f"non-JSON response:\n{text[:500]}")
    if not data:
        die("response data[] is empty")
    if a.out and len(data) > 1:
        die("--out fits a single image only; use --out-dir for multiple")

    now = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = Path(a.out).resolve() if a.out else None
    out_dir = out_path.parent if out_path else Path(a.out_dir or Path.cwd()).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = "t2i" if a.cmd == "gen" else "i2i"

    for i, item in enumerate(data, 1):
        m = re.search(r"\.(png|jpe?g|webp|gif)(?:\?|$)", str(item.get("url", "")), re.I)
        ext = m.group(1).lower().replace("jpeg", "jpg") if m else "png"
        f = out_path or out_dir / f"{prefix}-{now}{'' if len(data) == 1 else f'-{i}'}.{ext}"
        if item.get("b64_json"):
            buf = base64.b64decode(item["b64_json"])
        elif item.get("url"):
            try:
                with urllib.request.urlopen(item["url"], timeout=120) as r:
                    buf = r.read()
            except Exception as e:
                die(f"failed to download result image: {e} url={str(item['url'])[:120]}")
        else:
            die("response contains neither b64_json nor url")
        f.write_bytes(buf)
        print(f"SAVED {f} ({len(buf)} bytes, model={model})")


if __name__ == "__main__":
    main()
