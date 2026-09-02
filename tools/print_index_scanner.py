# -*- coding: utf-8 -*-
"""示意圖索引掃描器：NAS ro排單圖庫 → Supabase print_asset_index

跑在公司內網常開機（建議與 argo-tool 同一台，排程每小時）。
EIP 在 Vercel 摸不到內網，這支就是「內網 → 雲端索引」的橋，
只上傳「路徑與檔名」，設計圖本體不出內網。

用法：
    python tools/print_index_scanner.py --dry-run   # 只列出會建立的關聯，不寫庫
    python tools/print_index_scanner.py             # 實際同步（upsert + 清除消失的檔）

環境變數（讀 repo 根目錄 .env.local，或同名系統環境變數）：
    NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
    PRINT_NAS_ROOT（可選，預設 \\\\192.168.1.141\\ro排單圖庫）

排程範例（Windows 工作排程器，每小時）：
    schtasks /create /tn EIP_PrintIndex /sc hourly /tr
      "cmd /c cd /d C:\\path\\to\\repo && python tools\\print_index_scanner.py"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

DEFAULT_ROOT = r"\\192.168.1.141\RO排單圖庫"
ARCHIVE_ROOT = r"\\192.168.1.141\歷年排單圖庫2號倉"
# 主庫只掃 RO（其餘如 品保/印刷套版/胸章誤差測試 與訂單無關）
SCAN_SUBDIRS = ["RO"]
# 歸檔倉以「年月」資料夾分層（2601=2026年1月…），每月初舊單會從主庫搬過去。
# 只掃 2608（示意圖歸檔制度上路的 2026-08）以後的月份；更早的單本來就沒有示意圖。
ARCHIVE_MIN_YM = "2608"
ARCHIVE_YM_RE = re.compile(r"^\d{4}$")
# 訂單資料夾：以訂單號開頭（SO260817009 / SOA260810-090811-235…）。
# 單號只含數字與連字號——不能用 \w，Python 的 \w 會把中文吃進去
# （實例：資料夾「SO260604032捷旭電子」沒空格，\w 會把客戶名吞進單號）。
ORDER_DIR_RE = re.compile(r"^(?P<so>(?:SO[AB]?|RO)\d[\d-]*)")
# 可預覽示意圖：檔名前綴＋圖片/PDF 副檔名（其餘 eps/ai 等只入索引不預覽）
PREVIEW_PREFIX = "【商品示意圖】"
PREVIEW_EXTS = {"png", "jpg", "jpeg", "pdf"}
# 略過的系統資料夾與垃圾檔（Thumbs.db 是 Windows 縮圖快取，NAS 上到處都是）
SKIP_DIRS = {"#recycle", "@eaDir"}
SKIP_FILES = {"thumbs.db", "desktop.ini", ".ds_store"}


def load_env() -> dict[str, str]:
    env = dict(os.environ)
    env_file = Path(__file__).resolve().parent.parent / ".env.local"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"'))
    return env


def iter_order_dirs(base: Path, month_filter: re.Pattern | None = None,
                    min_ym: str | None = None):
    """找出 base 下的訂單資料夾（(單號, 路徑)）。

    結構有兩層可能：訂單直接在 base 下，或先分月份夾（八月/九月、歸檔倉的 2608）
    再放訂單。月初歸檔會搬移資料夾，兩層都要看；只往下鑽一層，不無限遞迴。"""
    for d in base.iterdir():
        if not d.is_dir() or d.name in SKIP_DIRS:
            continue
        m = ORDER_DIR_RE.match(d.name)
        if m:
            yield m.group("so"), d
            continue
        if month_filter and not month_filter.match(d.name):
            pass  # 主庫的月份夾是中文（八月/九月），不設格式限制；歸檔倉才過濾
        if min_ym and (not ARCHIVE_YM_RE.match(d.name) or d.name < min_ym):
            continue  # 歸檔倉：只收 2608 以後的年月夾
        try:
            for d2 in d.iterdir():
                if not d2.is_dir() or d2.name in SKIP_DIRS:
                    continue
                m2 = ORDER_DIR_RE.match(d2.name)
                if m2:
                    yield m2.group("so"), d2
        except OSError:
            continue


def scan(root: Path) -> list[dict]:
    """走訪主庫與歸檔倉的訂單資料夾，回傳索引列。訂單關聯只看資料夾名。"""
    rows: list[dict] = []
    # rel_path 一律含「共享名」開頭（如 RO排單圖庫\RO\八月\…），
    # 讓主庫與歸檔倉共用同一欄位；前端用 \192.168.1.141 + rel_path 組完整路徑。
    targets: list[tuple[Path, Path, str | None]] = [
        (root / sub, root, None) for sub in SCAN_SUBDIRS
    ]
    archive = Path(os.environ.get("PRINT_NAS_ARCHIVE", ARCHIVE_ROOT))
    if archive.is_dir():
        targets.append((archive, archive, ARCHIVE_MIN_YM))
    else:
        print(f"⚠ 歸檔倉連不上（{archive}），本輪只掃主庫")
    for base, share_root, min_ym in targets:
        if not base.is_dir():
            print(f"⚠ 找不到 {base}，略過")
            continue
        # UNC 共享名：不能用 Path.name——\host\share 整段是「錨點」，.name 會回空字串
        share_name = str(share_root).rstrip("\\").split("\\")[-1]
        for so, order_dir in iter_order_dirs(base, min_ym=min_ym):
            for f in order_dir.rglob("*"):
                if not f.is_file():
                    continue
                if any(part in SKIP_DIRS for part in f.parts):
                    continue
                if f.name.lower() in SKIP_FILES or f.name.startswith("~$"):
                    continue
                ext = f.suffix.lower().lstrip(".")
                st = f.stat()
                rows.append({
                    "so_no": so,
                    "rel_path": share_name + "\\" + str(f.relative_to(share_root)),
                    "file_name": f.name,
                    "ext": ext or None,
                    "is_preview": f.name.startswith(PREVIEW_PREFIX) and ext in PREVIEW_EXTS,
                    "size_bytes": st.st_size,
                    "file_mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                })
    return rows


def supa(env: dict[str, str], method: str, path: str, body: object | None = None,
         prefer: str | None = None) -> tuple[int, str]:
    url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path
    headers = {
        "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
        "Authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    # 瞬斷重試：批次上傳幾千列偶爾會遇到 TLS 中斷，重試三次再放棄
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return res.status, res.read().decode()
        except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
            return e.code, e.read().decode()
        except (urllib.error.URLError, OSError) as e:  # type: ignore[attr-defined]
            last_err = e
            import time
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Supabase 連線重試三次仍失敗：{last_err}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列出結果，不寫資料庫")
    args = ap.parse_args()

    env = load_env()
    root = Path(env.get("PRINT_NAS_ROOT", DEFAULT_ROOT))
    if not root.is_dir():
        print(f"❌ NAS 連不上：{root}（保留既有索引，不清空）")
        return 1

    started = datetime.now()
    rows = scan(root)
    orders = sorted({r["so_no"] for r in rows})
    print(f"掃描完成：{len(orders)} 張單、{len(rows)} 個檔"
          f"（示意圖 {sum(1 for r in rows if r['is_preview'])} 個）"
          f"，耗時 {(datetime.now() - started).total_seconds():.1f}s")

    if args.dry_run:
        for so in orders:
            files = [r for r in rows if r["so_no"] == so]
            pv = sum(1 for r in files if r["is_preview"])
            print(f"  {so:<24} {len(files):>3} 檔（示意圖 {pv}）")
        print("（dry-run：未寫入資料庫）")
        return 0

    # 護欄：掃到 0 檔（如資料夾被搬走）不寫入也不清空，避免把索引洗掉
    if not rows:
        print("⚠ 掃到 0 檔，本輪不寫入、不清除")
        return 1

    stamp = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r["scanned_at"] = stamp
    # upsert（500 筆一批）
    for i in range(0, len(rows), 500):
        code, text = supa(env, "POST", "print_asset_index?on_conflict=so_no,rel_path",
                          rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
        if code >= 300:
            print(f"❌ upsert 失敗 HTTP {code}: {text[:200]}")
            return 1
    # 清除本輪沒掃到的（改名/刪除的檔）。
    # 時間戳要 URL 編碼：+00:00 的「+」在 query string 會被當成空格。
    from urllib.parse import quote
    code, text = supa(env, "DELETE",
                      f"print_asset_index?scanned_at=lt.{quote(stamp)}", prefer="return=minimal")
    if code >= 300:
        print(f"⚠ 清除舊列失敗 HTTP {code}: {text[:200]}")
    print(f"✅ 已同步 {len(rows)} 列（{len(orders)} 張單）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
