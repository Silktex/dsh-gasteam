"""Project the experimental Team recording through the Python SDK and shipped SDK profile."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil

from deepseek_harness import DeepSeekHarness


ROOT = Path(__file__).resolve().parents[3]
SCENARIO = ROOT / "snapshots" / "sdk" / "team-task-evidence"


def test_python_sdk_projects_durable_team_task_and_batch_events(tmp_path: Path) -> None:
    node = shutil.which("node")
    assert node is not None, "the Team source-profile snapshot requires the repository Node toolchain"
    fixture = SCENARIO / "session.jsonl"
    rows = [json.loads(line) for line in fixture.read_text().splitlines()]
    task = next(row["data"]["content"][0]["text"] for row in rows
                if row["type"] == "user/message" and row["data"].get("source", {}).get("kind") == "user")
    header = next(row["data"]["header"]["config"] for row in rows if row["type"] == "request/header")
    patches = [
        ROOT / "snapshots/session/text-turn/cordis.yml",
        ROOT / "snapshots/session/team-task-evidence/cordis.snapshot.yml",
        ROOT / "snapshots/session/text-turn/model.cordis.yml",
    ]
    launch = (node, "--import", str(ROOT / "node_modules/tsx/dist/esm/index.mjs"),
              str(ROOT / "apps/cli/src/bin.ts"), "--profile", "sdk",
              *(argument for patch in patches for argument in ("--patch", str(patch))))
    with DeepSeekHarness(
        provider=header["provider"], model=header["model"], cwd=str(tmp_path),
        dsh_home=str(tmp_path / ".dsh"), request_timeout_seconds=60,
        env={
            "DSH_HOME": str(tmp_path / ".dsh"),
            "DSH_AGENTS_HOME": str(tmp_path / ".agents"),
            "DSH_SNAPSHOT": "replay", "DSH_SNAPSHOT_FILE": str(fixture),
            "DSH_SNAPSHOT_PROVIDER": header["provider"], "DSH_SNAPSHOT_MODEL": header["model"],
            "DSH_TELEMETRY_DISABLED": "1", "TSX_TSCONFIG_PATH": str(ROOT / "tsconfig.json"),
        },
        _launch_args=launch,
    ) as harness:
        result = harness.run(task, session_id="python-team-fixture")
    events = [{"type": event["type"], "data": event["data"]}
              for event in result.events if str(event.get("type", "")).startswith("team/")]
    for event in events:
        event["data"]["teamId"] = "{{session:1}}"
        if "task" in event["data"] and "ownerId" in event["data"]["task"]:
            event["data"]["task"]["ownerId"] = "{{session:1}}"
    actual = {"final_response": result.final_response, "finish_reason": result.finish_reason, "events": events}
    expected = SCENARIO / "python.result.expected.json"
    if os.environ.get("DSH_SNAPSHOT") == "refresh":
        expected.write_text(json.dumps(actual, ensure_ascii=False, indent=2) + "\n")
    assert actual == json.loads(expected.read_text())
