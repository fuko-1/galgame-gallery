"""Reduce Bangumi's official public wiki archive to game recommendation metadata.

Only IDs, tags, staff and game-to-game relationships are published. The large
source ZIP stays in .cache; no account token or private collection is required.
Constants: https://github.com/bangumi/common (subject_relations/subject_staffs).
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
import re
import tempfile
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
import zipfile

LATEST = "https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json"
UA = "fuko-galgame-gallery/2.0 (https://github.com/fuko-1/galgame-gallery)"
EQUIVALENT = {1, 4010, 4011, 4013, 4016, 4017}
REQUIRED_FILES = {"subject.jsonlines", "subject-relations.jsonlines", "subject-persons.jsonlines", "person.jsonlines"}
CLASSIFICATION_VERSION = 1
GAL_TAG = re.compile(r"^(?:galgame|gal|visual[ _-]*novel|视觉小说|視覺小說|文字冒险|文字冒險|美少女游戏|美少女遊戲)$", re.I)
NOVEL_GENRE = re.compile(
    r"visual[ _-]*novel|sound[ _-]*novel|视觉小说|視覺小說|文字冒险|文字冒險|"
    r"恋愛|恋爱|戀愛|美少女|ノベル|\bVN\b|\bNVL\b|\bLVNS?\b|"
    r"極限脱出ADV|极限脱出ADV|想定科学ADV|科学ADV", re.I)
# These genres describe gameplay, not a visual novel, even for a Galgame spin-off.
OTHER_GENRE = re.compile(r"\b(?:FTG|STG|FPS|TPS|MOBA|RAC|SPG|MMORPG|CRPG)\b", re.I)
HYBRID_GENRE = re.compile(r"\b(?:ACT|ARPG|SRPG|RPG|SLG|SIM)\b", re.I)


def classify_galgame(row):
    match = re.search(r"^\|游戏类型[ \t]*=[ \t]*([^\r\n]*)", row.get("infobox", ""), re.M)
    genre = match.group(1).strip() if match else ""
    if NOVEL_GENRE.search(genre):
        return True, "visual_novel_genre"
    if OTHER_GENRE.search(genre):
        return False, "other_game_genre"
    tags = row.get("tags", [])
    maximum = max((t.get("count", 0) for t in tags), default=0)
    # A stray user tag cannot reclassify a popular action/adventure game.
    if any(GAL_TAG.fullmatch(t.get("name", "")) and t.get("count", 0) >= max(2, maximum * 0.15) for t in tags):
        return True, "community_consensus"
    wiki_gal = any(GAL_TAG.fullmatch(t) for t in row.get("meta_tags", []) if isinstance(t, str))
    if wiki_gal and (not HYBRID_GENRE.search(genre) or maximum <= 10):
        return True, "wiki_galgame"
    return False, "insufficient_galgame_evidence"


def rows(archive, filename):
    with archive.open(filename) as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


class Groups:
    def __init__(self, ids):
        self.parent = {i: i for i in ids}

    def find(self, i):
        p = self.parent[i]
        if p != i:
            self.parent[i] = self.find(p)
        return self.parent[i]

    def join(self, a, b):
        a, b = self.find(a), self.find(b)
        self.parent[max(a, b)] = min(a, b)


def build_metadata(archive_path, wanted, source):
    with zipfile.ZipFile(archive_path) as archive:
        if not REQUIRED_FILES.issubset(archive.namelist()):
            raise ValueError("官方档案缺少所需文件，保留原快照")
        if any(archive.getinfo(name).file_size > 2_000_000_000 for name in REQUIRED_FILES):
            raise ValueError("档案文件超过安全大小")
        games, subjects = set(), {}
        for row in rows(archive, "subject.jsonlines"):
            if row["type"] != 4:
                continue
            sid = row["id"]
            games.add(sid)
            if sid not in wanted:
                continue
            tags = [t["name"] for t in row.get("tags", []) if isinstance(t.get("name"), str)]
            is_galgame, evidence = classify_galgame(row)
            subjects[str(sid)] = {
                "work_id": sid, "tags": tags[:15], "writers": [], "developers": [],
                "is_galgame": is_galgame, "galgame_evidence": evidence,
                "prequels": [], "parents": [], "collection": False,
                "date": row.get("date", ""),
            }
        if len(subjects) < max(1, len(wanted) * 0.85):
            raise ValueError("档案中可用游戏不足 85%，保留原快照")
        groups = Groups(games)
        edges = []
        for row in rows(archive, "subject-relations.jsonlines"):
            a, b, kind = row["subject_id"], row["related_subject_id"], row["relation_type"]
            # An anime adaptation must never join the identities of two games.
            if a not in games or b not in games:
                continue
            if kind in EQUIVALENT:
                groups.join(a, b)
            if kind in {4002, 4003, 4006, 4012, 4019}:
                edges.append((a, b, kind))
        for sid, record in subjects.items():
            record["work_id"] = groups.find(int(sid))
        for a, b, kind in edges:
            if kind == 4003:
                a, b, kind = b, a, 4002
            elif kind == 4006:
                a, b, kind = b, a, 4012
            record = subjects.get(str(a))
            if not record:
                continue
            if kind == 4019:
                record["collection"] = True
            else:
                field = "prequels" if kind == 4002 else "parents"
                record[field].append(groups.find(b))
        staff_ids = set()
        for row in rows(archive, "subject-persons.jsonlines"):
            record = subjects.get(str(row["subject_id"]))
            if not record or row["position"] not in {1001, 1004}:
                continue
            pid = row["person_id"]
            record["writers" if row["position"] == 1004 else "developers"].append(pid)
            staff_ids.add(pid)
        persons = {str(r["id"]): r["name"] for r in rows(archive, "person.jsonlines") if r["id"] in staff_ids}
        for record in subjects.values():
            for field in ("writers", "developers", "prequels", "parents"):
                record[field] = sorted(set(record[field]))
            for field in ("writers", "developers"):
                record[field] = [pid for pid in record[field] if str(pid) in persons]
        if not persons:
            raise ValueError("档案未解析出任何剧本作者或开发商")
        return {"schema_version": 1, "classification_version": CLASSIFICATION_VERSION,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "source": source, "count": len(subjects), "subjects": subjects, "persons": persons}


def atomic_json(output, payload):
    output.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, suffix=".tmp", delete=False) as file:
            name = file.name
            json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
        os.replace(name, output)
    finally:
        if name and Path(name).exists():
            Path(name).unlink()


def publish_classifications(gallery, mine, metadata, gallery_output, mine_output):
    if metadata.get("classification_version") != CLASSIFICATION_VERSION:
        raise ValueError("类型分类规则已更新，必须重建元数据")
    records = metadata["subjects"]
    def accepted(subject):
        return records.get(str(subject["id"]), {}).get("is_galgame") is True
    for subject in gallery["subjects"]:
        subject["is_galgame"] = accepted(subject)
    for collection in mine["collections"]:
        if collection["subject_type"] == 4:
            collection["subject"]["is_galgame"] = accepted(collection["subject"])
    accepted_count = sum(s["is_galgame"] for s in gallery["subjects"])
    stamp = {"version": CLASSIFICATION_VERSION, "source_digest": metadata["source"].get("digest", "")}
    gallery["galgame_classification"] = {**stamp, "accepted_count": accepted_count}
    mine["galgame_classification"] = stamp
    # Keep the raw tag catalogue for complete pagination checks and cover caches.
    # The page only displays explicitly accepted subjects; unknown new IDs wait
    # for the next archive instead of bypassing classification.
    atomic_json(gallery_output, gallery)
    atomic_json(mine_output, mine)
    print(f"类型筛选完成：保留 {accepted_count} 部，过滤 {gallery['count'] - accepted_count} 部非 Galgame 或证据不足的游戏")


def latest_archive():
    with urlopen(Request(LATEST, headers={"User-Agent": UA}), timeout=30) as response:
        info = json.load(response)
    if not info["browser_download_url"].startswith("https://github.com/bangumi/Archive/releases/download/"):
        raise ValueError("档案下载地址不是 Bangumi 官方发布地址")
    if not re.fullmatch(r"dump-[\w.\-]+\.zip", info["name"]) or not 0 < info["size"] < 1_000_000_000:
        raise ValueError("档案名称或大小无效")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", info.get("digest", "")):
        raise ValueError("档案缺少 SHA-256 校验值")
    return info


def verify_archive(path, info):
    if not path.exists() or path.stat().st_size != info["size"]:
        return False
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest() == info["digest"].split(":")[1]


def download_archive(info, cache):
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / info["name"]
    if verify_archive(target, info):
        return target
    temporary = target.with_suffix(".zip.tmp")
    for attempt in range(3):
        try:
            deadline = time.monotonic() + 600
            with urlopen(Request(info["browser_download_url"], headers={"User-Agent": UA}), timeout=30) as response, temporary.open("wb") as file:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > info["size"] or time.monotonic() > deadline:
                        raise ValueError("档案下载超过预期大小或时间上限")
                    file.write(chunk)
            if not verify_archive(temporary, info):
                raise ValueError("档案大小或 SHA-256 校验失败")
            os.replace(temporary, target)
            return target
        except Exception:
            if temporary.exists():
                temporary.unlink()
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, help="已下载的官方 ZIP（仍校验官方摘要）")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    output = root / config["recommendations"]["snapshotFile"]
    gallery_output = root / config["galgame"]["snapshotFile"]
    mine_output = root / config["bangumi"]["snapshotFile"]
    gallery = json.loads(gallery_output.read_text(encoding="utf-8"))
    mine = json.loads(mine_output.read_text(encoding="utf-8"))
    previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
    info = latest_archive()
    if previous and previous.get("schema_version") == 1 and previous.get("classification_version") == CLASSIFICATION_VERSION and previous.get("source", {}).get("digest") == info["digest"] and not args.force:
        publish_classifications(gallery, mine, previous, gallery_output, mine_output)
        print("推荐关系档案未更新，使用现有元数据")
        return
    archive = args.archive or download_archive(info, root / ".cache" / "archive")
    if not verify_archive(archive, info):
        raise ValueError("本地档案与官方 SHA-256 不符")
    wanted = {s["id"] for s in gallery["subjects"]} | {c["subject_id"] for c in mine["collections"] if c["subject_type"] == 4}
    result = build_metadata(archive, wanted, {"url": info["browser_download_url"], "date": info["created_at"], "digest": info["digest"]})
    if previous and result["count"] < previous["count"] * 0.85:
        raise ValueError("推荐元数据数量下降超过 15%，保留原快照")
    atomic_json(output, result)
    publish_classifications(gallery, mine, result, gallery_output, mine_output)
    print(f"推荐元数据更新完成，共 {result['count']} 个游戏")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
