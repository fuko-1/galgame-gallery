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


if __name__ == "__main__":
    unittest.main()
