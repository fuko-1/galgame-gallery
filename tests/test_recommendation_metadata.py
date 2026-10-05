import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("metadata", Path(__file__).resolve().parent.parent / "scripts/update-recommendation-metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="galgame-metadata-")
        self.root = Path(self.directory.name)
        self.assertEqual(self.root.parent.resolve(), Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.directory.cleanup)

    def archive(self, relations=None, subjects=None):
        target = self.root / "source.zip"
        if subjects is None:
            subjects = [{"id": i, "type": 4, "tags": [{"name": "悬疑"}], "meta_tags": ["Galgame"], "date": "2025-01-01"} for i in [1, 2, 3, 4]]
            subjects.append({"id": 99, "type": 2})
        files = {
            "subject.jsonlines": subjects,
            "subject-relations.jsonlines": [{"subject_id": a, "related_subject_id": b, "relation_type": kind} for a, b, kind in (relations or [])],
            "subject-persons.jsonlines": [{"subject_id": i, "person_id": 7, "position": 1004} for i in [1, 2, 3, 4]],
            "person.jsonlines": [{"id": 7, "name": "剧本作者"}],
        }
        with zipfile.ZipFile(target, "w") as archive:
            for name, records in files.items():
                archive.writestr(name, "\n".join(json.dumps(r, ensure_ascii=False) for r in records).encode())
        return target

    def test_equivalent_relations_are_transitive_even_outside_the_candidate_list(self):
        archive = self.archive([(1, 2, 4016), (2, 3, 4010), (1, 4, 4003)])
        result = metadata.build_metadata(archive, {1, 3, 4}, {})
        self.assertEqual(result["subjects"]["3"]["work_id"], 1)
        self.assertEqual(result["subjects"]["4"]["work_id"], 4)
        self.assertEqual(result["subjects"]["4"]["prequels"], [1])

    def test_reverse_prequels_and_side_stories_do_not_merge_work_identity(self):
        archive = self.archive([(2, 1, 4002), (1, 3, 4006), (4, 1, 4019)])
        result = metadata.build_metadata(archive, {1, 2, 3, 4}, {})
        self.assertEqual(result["subjects"]["2"]["prequels"], [1])
        self.assertEqual(result["subjects"]["3"]["parents"], [1])
        self.assertTrue(result["subjects"]["4"]["collection"])
        self.assertEqual(len({r["work_id"] for r in result["subjects"].values()}), 4)

    def test_anime_adaptations_do_not_join_two_game_stories(self):
        archive = self.archive([(1, 99, 1), (99, 2, 1)])
        result = metadata.build_metadata(archive, {1, 2}, {})
        self.assertNotEqual(result["subjects"]["1"]["work_id"], result["subjects"]["2"]["work_id"])

    def test_official_staff_roles_and_unicode_survive_the_reduced_snapshot(self):
        result = metadata.build_metadata(self.archive(), {1}, {})
        self.assertEqual(result["subjects"]["1"]["writers"], [7])
        self.assertEqual(result["persons"]["7"], "剧本作者")
        self.assertEqual(result["subjects"]["1"]["tags"], ["悬疑"])
        output = self.root / "out.json"
        metadata.atomic_json(output, result)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), result)
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_incomplete_archive_cannot_replace_a_good_snapshot(self):
        output = self.root / "out.json"
        output.write_text('{"old":true}', encoding="utf-8")
        with self.assertRaises(ValueError):
            metadata.build_metadata(self.archive(), {1, 100, 101, 102}, {})
        self.assertEqual(output.read_text(encoding="utf-8"), '{"old":true}')
        invalid = self.root / "invalid.zip"
        with zipfile.ZipFile(invalid, "w") as archive:
            archive.writestr("subject.jsonlines", "{}")
        with self.assertRaises(ValueError):
            metadata.build_metadata(invalid, {1}, {})

    def test_download_size_and_digest_are_both_required(self):
        archive = self.archive()
        import hashlib
        info = {"size": archive.stat().st_size, "digest": "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest()}
        self.assertTrue(metadata.verify_archive(archive, info))
        self.assertFalse(metadata.verify_archive(archive, {**info, "size": info["size"] + 1}))
        self.assertFalse(metadata.verify_archive(archive, {**info, "digest": "sha256:" + "0" * 64}))

    def test_real_type_evidence_rejects_unrelated_games_and_preserves_novels_and_hybrids(self):
        fixture = Path(__file__).parent / "fixtures/galgame-types.json"
        for case in json.loads(fixture.read_text(encoding="utf-8")):
            with self.subTest(id=case["subject"]["id"], name=case["subject"]["name"]):
                accepted, evidence = metadata.classify_galgame(case["subject"])
                self.assertEqual(accepted, case["expected"])
                self.assertTrue(evidence)

    def test_generic_adventure_and_stray_tags_cannot_reclassify_an_unrelated_game(self):
        for genre in ["AVG", "ADV", "AAVG", "ARPG", "RPG", "ACT"]:
            row = {"infobox": f"|游戏类型= {genre}", "tags": [{"name": "开放世界", "count": 800}, {"name": "Galgame", "count": 1}]}
            self.assertFalse(metadata.classify_galgame(row)[0], genre)
        # A blank field must not consume the following line as the genre.
        self.assertFalse(metadata.classify_galgame({"infobox": "|游戏类型=\n|游戏引擎= Visual Novel Engine"})[0])
        self.assertFalse(metadata.classify_galgame({"infobox": "|游戏类型= FTG", "meta_tags": ["Galgame"], "tags": [{"name": "GAL", "count": 15}]})[0])
        self.assertTrue(metadata.classify_galgame({"infobox": "|游戏类型= ADV＋ACT", "meta_tags": ["Galgame"]})[0])
        self.assertTrue(metadata.classify_galgame({"infobox": "|游戏类型= Visual Novel"})[0])
        self.assertTrue(metadata.classify_galgame({"infobox": "|游戏类型= 恋愛SLG"})[0])

    def test_every_refresh_reapplies_type_flags_without_losing_covers_or_collections(self):
        result = metadata.build_metadata(self.archive(), {1, 2, 3, 4}, {"digest": "test-digest"})
        result["subjects"]["2"]["is_galgame"] = False
        gallery = {"count": 3, "updated_at": "2026-10-05", "subjects": [{"id": 1, "images": {"small": "https://example.org/cover.jpg"}}, {"id": 2}, {"id": 999}]}
        mine = {"count": 2, "collections": [{"subject_type": 4, "subject": {"id": 2}}, {"subject_type": 2, "subject": {"id": 3}}]}
        for _ in range(2):
            metadata.publish_classifications(gallery, mine, result, self.root / "gal.json", self.root / "mine.json")
            saved = json.loads((self.root / "gal.json").read_text(encoding="utf-8"))
            self.assertEqual([s["is_galgame"] for s in saved["subjects"]], [True, False, False])
            self.assertEqual(saved["subjects"][0]["images"]["small"], "https://example.org/cover.jpg")
            self.assertEqual(saved["updated_at"], "2026-10-05")
            self.assertEqual(saved["count"], 3)
            self.assertEqual(saved["galgame_classification"]["accepted_count"], 1)
            self.assertFalse(mine["collections"][0]["subject"]["is_galgame"])
            self.assertNotIn("is_galgame", mine["collections"][1]["subject"])
            # Simulate the next fresh scrape stripping computed fields.
            for s in gallery["subjects"]: s.pop("is_galgame")
        with self.assertRaises(ValueError):
            metadata.publish_classifications(gallery, mine, {**result, "classification_version": 0}, self.root / "gal.json", self.root / "mine.json")


if __name__ == "__main__":
    unittest.main()
