import json
import tempfile
import unittest
from pathlib import Path

import roadmap_store


class AskRoadmapTests(unittest.TestCase):
    def test_stale_snapshot_preserves_accepted_tasks_and_retry_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ROADMAP.json"
            snapshot = {"tasks": [{"id": "existing", "status": "approved"}],
                        "ask_intakes": {}}
            latest = {"tasks": [*snapshot["tasks"], {"id": "new", "status": "pending"}],
                      "ask_intakes": {"receipt": {"hash": "hash", "tasks": [{"id": "new"}]}}}
            path.write_text(json.dumps(latest))
            roadmap_store.save_roadmap(path, snapshot)
            saved = json.loads(path.read_text())
            self.assertEqual(saved["tasks"], latest["tasks"])
            self.assertEqual(saved["ask_intakes"], latest["ask_intakes"])
