#!/usr/bin/env python3
"""Delegate approved tasks to Pi with model discovery, monitoring, and metrics."""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONFIG_DIR = Path.home() / ".pi" / "agent" / "skills" / "pi-delegator"
CONFIG_PATH = CONFIG_DIR / "config.json"
THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh"}


@dataclass
class ModelInfo:
    provider: str
    model: str
    context: str = ""
    max_out: str = ""
    thinking: str = ""
    images: str = ""

    @property
    def ref(self) -> str:
        return f"{self.provider}/{self.model}"

    @property
    def is_free(self) -> bool:
        return self.provider == "opencode-cli"

    @property
    def supports_thinking(self) -> bool:
        return self.thinking.lower() == "yes"


def fail(message: str, code: int = 1) -> None:
    print(f"✗ {message}", file=sys.stderr)
    raise SystemExit(code)


def ensure_pi() -> None:
    if not shutil.which("pi"):
        fail("Pi CLI not found. Install Pi first: npm install -g @earendil-works/pi-coding-agent")


def run_pi_list_models() -> str:
    ensure_pi()
    proc = subprocess.run(
        ["pi", "--list-models"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        fail(f"Failed to list Pi models. stderr: {proc.stderr.strip() or 'not reported'}")
    # Pi currently prints --list-models to stderr because it is a CLI display
    # command. Accept either stream so this helper survives future changes.
    return proc.stdout or proc.stderr


def parse_models(table: str) -> list[ModelInfo]:
    models: list[ModelInfo] = []
    for line in table.splitlines():
        line = line.rstrip()
        if not line or line.startswith("provider"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        # Current Pi output columns: provider model context max-out thinking images.
        provider, model = parts[0], parts[1]
        rest = parts[2:]
        models.append(
            ModelInfo(
                provider=provider,
                model=model,
                context=rest[0] if len(rest) > 0 else "",
                max_out=rest[1] if len(rest) > 1 else "",
                thinking=rest[2] if len(rest) > 2 else "",
                images=rest[3] if len(rest) > 3 else "",
            )
        )
    return models


def load_models() -> list[ModelInfo]:
    models = parse_models(run_pi_list_models())
    if not models:
        fail("No Pi models are available. Run `pi /login` or configure a provider first.")
    return models


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except json.JSONDecodeError as exc:
        fail(f"Invalid config at {CONFIG_PATH}: {exc}")


def save_config(config: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")


def find_model(models: list[ModelInfo], ref_or_model: str) -> ModelInfo | None:
    matches = [m for m in models if m.ref == ref_or_model]
    if matches:
        return matches[0]
    matches = [m for m in models if m.model == ref_or_model]
    if len(matches) == 1:
        return matches[0]
    return None


def score_model(model: ModelInfo, complexity: str) -> tuple[int, int, int, str]:
    name = model.model.lower()
    provider_bonus = 1000 if model.is_free else 0
    thinking_bonus = 50 if model.supports_thinking else 0

    if complexity == "simple":
        name_score = 0
        for marker, score in [
            ("flash", 120),
            ("mini", 100),
            ("mimo", 90),
            ("nano", 80),
            ("deepseek", 70),
            ("free", 20),
        ]:
            if marker in name:
                name_score += score
        return (provider_bonus, name_score, thinking_bonus, model.ref)

    if complexity == "complex":
        name_score = 0
        for marker, score in [
            ("ultra", 160),
            ("big-pickle", 150),
            ("opus", 140),
            ("gpt-5", 130),
            ("pro", 100),
            ("nemotron", 90),
            ("deepseek", 60),
        ]:
            if marker in name:
                name_score += score
        return (provider_bonus, name_score, thinking_bonus, model.ref)

    # medium
    name_score = 0
    for marker, score in [
        ("big-pickle", 130),
        ("nemotron", 120),
        ("deepseek", 100),
        ("flash", 60),
        ("free", 20),
    ]:
        if marker in name:
            name_score += score
    return (provider_bonus, name_score, thinking_bonus, model.ref)


def recommended_model(models: list[ModelInfo], complexity: str = "medium") -> ModelInfo:
    complexity = complexity if complexity in {"simple", "medium", "complex"} else "medium"
    return sorted(models, key=lambda m: score_model(m, complexity), reverse=True)[0]


def default_thinking(model: ModelInfo, complexity: str, requested: str | None = None) -> str:
    if requested:
        if requested not in THINKING_LEVELS:
            fail(f"Invalid thinking level: {requested}. Expected one of: {', '.join(sorted(THINKING_LEVELS))}")
        if requested != "off" and not model.supports_thinking:
            return "off"
        return requested
    if not model.supports_thinking:
        return "off"
    if complexity == "simple":
        return "minimal"
    if complexity == "complex":
        return "high"
    return "low"


def command_models(args: argparse.Namespace) -> None:
    models = load_models()
    config = load_config()
    configured_ref = config.get("defaultModel")
    configured = find_model(models, configured_ref) if configured_ref else None
    rec = recommended_model(models, args.complexity)

    if args.json:
        print(json.dumps({
            "configPath": str(CONFIG_PATH),
            "configuredDefault": configured.ref if configured else None,
            "configuredAvailable": bool(configured),
            "recommended": rec.ref,
            "recommendedThinking": default_thinking(rec, args.complexity),
            "freeProviderAvailable": any(m.is_free for m in models),
            "models": [m.__dict__ | {"ref": m.ref, "free": m.is_free} for m in models],
        }, indent=2))
        return

    print("◆ Pi Models")
    print("┄" * 40)
    print(f"  Config:      {CONFIG_PATH}")
    if configured:
        print(f"  Saved:       {configured.ref} ({config.get('defaultThinking', 'not set')})")
    elif configured_ref:
        print(f"  Saved:       {configured_ref} (unavailable)")
    else:
        print("  Saved:       not configured")
    print(f"  Recommended: {rec.ref} ({default_thinking(rec, args.complexity)})")
    if any(m.is_free for m in models):
        print("  Free:        opencode-cli available ✓")
    else:
        print("  Free:        opencode-cli not available")
    print()
    print("  Available models:")
    for m in models:
        marker = "★" if m.ref == rec.ref else " "
        free = "free" if m.is_free else "paid/unknown"
        print(
            f"  {marker} {m.ref}  context={m.context or '?'} "
            f"thinking={m.thinking or '?'} {free}"
        )


def command_configure(args: argparse.Namespace) -> None:
    models = load_models()
    model = find_model(models, args.model)
    if not model:
        fail(f"Model not available in Pi: {args.model}. Run `pi --list-models` to inspect choices.")
    thinking = default_thinking(model, "medium", args.thinking)
    config = load_config()
    config.update({
        "defaultModel": model.ref,
        "defaultThinking": thinking,
        "preferFreeProvider": True,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    save_config(config)
    print("✓ Pi delegator default saved")
    print(f"  Config:    {CONFIG_PATH}")
    print(f"  Model:     {model.ref}")
    print(f"  Thinking:  {thinking}")


def read_task(args: argparse.Namespace) -> str:
    if args.task_file:
        path = Path(args.task_file)
        if not path.exists():
            fail(f"Task file not found: {path}")
        return path.read_text()
    if args.task:
        return args.task
    if not sys.stdin.isatty():
        return sys.stdin.read()
    fail("No task provided. Use --task-file, --task, or pipe a prompt on stdin.")


def stderr_pump(proc: subprocess.Popen[str]) -> None:
    assert proc.stderr is not None
    for line in proc.stderr:
        text = line.rstrip()
        if text:
            print(f"  stderr: {text}", file=sys.stderr)


def send_rpc(proc: subprocess.Popen[str], payload: dict[str, Any]) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


def compact_stats(data: dict[str, Any] | None) -> dict[str, Any]:
    if not data:
        return {}
    tokens = data.get("tokens") or {}
    return {
        "sessionFile": data.get("sessionFile"),
        "sessionId": data.get("sessionId"),
        "userMessages": data.get("userMessages"),
        "assistantMessages": data.get("assistantMessages"),
        "toolCalls": data.get("toolCalls"),
        "tokens": {
            "input": tokens.get("input"),
            "output": tokens.get("output"),
            "cacheRead": tokens.get("cacheRead"),
            "cacheWrite": tokens.get("cacheWrite"),
            "total": tokens.get("total"),
        },
        "cost": data.get("cost"),
        "contextUsage": data.get("contextUsage"),
    }


def value_or_unknown(value: Any) -> str:
    if value is None:
        return "not reported"
    return str(value)


def command_run(args: argparse.Namespace) -> None:
    if not args.approved:
        fail("Refusing to run without --approved. Get explicit user approval first.")

    ensure_pi()
    cwd = Path(args.cwd).expanduser().resolve()
    if not cwd.exists() or not cwd.is_dir():
        fail(f"Target cwd does not exist or is not a directory: {cwd}")

    models = load_models()
    config = load_config()
    selected = find_model(models, args.model) if args.model else None
    if args.model and not selected:
        fail(f"Model not available in Pi: {args.model}. Run `pi --list-models` to inspect choices.")
    if not selected:
        configured = find_model(models, config.get("defaultModel", ""))
        free = recommended_model(models, args.complexity) if any(m.is_free for m in models) else None
        selected = free or configured or recommended_model(models, args.complexity)
    thinking = default_thinking(selected, args.complexity, args.thinking or config.get("defaultThinking"))
    task = read_task(args).strip()
    if not task:
        fail("Task is empty. Provide a clear delegated task.")

    cmd = [
        "pi",
        "--mode", "rpc",
        "--model", selected.ref,
        "--thinking", thinking,
        "--name", args.session_name,
    ]
    if args.tools:
        cmd.extend(["--tools", args.tools])
    if args.approve_project:
        cmd.append("--approve")
    if args.no_session:
        cmd.append("--no-session")

    start = time.time()
    print("◆ Pi Delegation Run")
    print("┄" * 40)
    print(f"  Cwd:       {cwd}")
    print(f"  Model:     {selected.ref}")
    print(f"  Thinking:  {thinking}")
    print(f"  Tools:     {args.tools or 'Pi default'}")
    print()

    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    threading.Thread(target=stderr_pump, args=(proc,), daemon=True).start()

    send_rpc(proc, {"id": "prompt-1", "type": "prompt", "message": task})

    turn_count = 0
    retry_count = 0
    compaction_count = 0
    stats: dict[str, Any] | None = None
    final_text: str | None = None
    requested_stats = False
    stats_requested_at: float | None = None
    result = "FAILED"

    assert proc.stdout is not None
    try:
        while True:
            if proc.poll() is not None:
                break
            if requested_stats and stats_requested_at and time.time() - stats_requested_at > args.stats_timeout:
                print("⚠ Timed out waiting for Pi session stats; finishing with partial metrics")
                result = "DONE"
                break

            ready, _, _ = select.select([proc.stdout], [], [], 1)
            if not ready:
                continue
            raw_line = proc.stdout.readline()
            if raw_line == "":
                break
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                print(f"⚠ Non-JSON output from Pi: {line[:200]}")
                continue

            etype = event.get("type")
            if args.verbose:
                print(json.dumps(event, ensure_ascii=False)[:2000])

            if etype == "session":
                print(f"● Pi session started — {event.get('id', 'unknown')}")
            elif etype == "response":
                if not event.get("success", False):
                    print(f"✗ Pi command failed: {event.get('error', 'unknown error')}")
                    break
                if event.get("id") == "stats-1":
                    stats = event.get("data") or {}
                    result = "DONE"
                    break
            elif etype == "agent_start":
                print("● Pi agent started")
            elif etype == "turn_start":
                turn_count += 1
                print(f"● Turn {turn_count} started")
            elif etype == "tool_execution_start":
                print(f"● Tool started: {event.get('toolName', 'unknown')}")
            elif etype == "tool_execution_end":
                name = event.get("toolName", "unknown")
                if event.get("isError"):
                    print(f"✗ Tool failed: {name}")
                else:
                    print(f"✓ Tool complete: {name}")
            elif etype == "compaction_start":
                compaction_count += 1
                print(f"● Compaction started — {event.get('reason', 'unknown')}")
            elif etype == "compaction_end":
                if event.get("errorMessage"):
                    print(f"⚠ Compaction failed: {event.get('errorMessage')}")
                else:
                    print("✓ Compaction complete")
            elif etype == "auto_retry_start":
                retry_count += 1
                print(f"⚠ Retry {event.get('attempt')}/{event.get('maxAttempts')} after transient error")
            elif etype == "auto_retry_end":
                print("✓ Retry recovered" if event.get("success") else "✗ Retry failed")
            elif etype == "agent_end":
                print("✓ Pi agent finished")
                for message in reversed(event.get("messages") or []):
                    if message.get("role") == "assistant":
                        parts = message.get("content") or []
                        texts = [part.get("text", "") for part in parts if part.get("type") == "text"]
                        final_text = "\n".join(text for text in texts if text)
                        break
                send_rpc(proc, {"id": "stats-1", "type": "get_session_stats"})
                requested_stats = True
                stats_requested_at = time.time()
    except KeyboardInterrupt:
        result = "ABORTED"
        try:
            send_rpc(proc, {"type": "abort"})
        except Exception:
            pass
    finally:
        duration = time.time() - start
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    summary = compact_stats(stats)
    tokens = summary.get("tokens", {})
    print()
    print("◆ Pi Delegation Complete")
    print("┄" * 40)
    print(f"  Result:       {result}")
    print(f"  Duration:     {duration:.1f}s")
    print(f"  Model:        {selected.ref}")
    print(f"  Thinking:     {thinking}")
    print(
        "  Tokens:       "
        f"input {value_or_unknown(tokens.get('input'))}, "
        f"output {value_or_unknown(tokens.get('output'))}, "
        f"cache read {value_or_unknown(tokens.get('cacheRead'))}, "
        f"cache write {value_or_unknown(tokens.get('cacheWrite'))}"
    )
    print(f"  Total tokens: {value_or_unknown(tokens.get('total'))}")
    print(f"  Cost:         {value_or_unknown(summary.get('cost'))}")
    print(f"  Tool calls:   {value_or_unknown(summary.get('toolCalls'))}")
    print(f"  Retries:      {retry_count}")
    print(f"  Compactions:  {compaction_count}")
    print(f"  Session:      {value_or_unknown(summary.get('sessionFile'))}")
    print("\n  Final response:")
    if final_text:
        for line in final_text.strip().splitlines()[:80]:
            print(f"  {line}")
    else:
        print("  not reported")

    if result != "DONE":
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Delegate approved tasks to Pi.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_models = sub.add_parser("models", help="List available Pi models and recommendation")
    p_models.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    p_models.add_argument("--prefer-free", action="store_true", help="Prefer opencode-cli in recommendation")
    p_models.add_argument("--complexity", choices=["simple", "medium", "complex"], default="medium")
    p_models.set_defaults(func=command_models)

    p_config = sub.add_parser("configure", help="Save default model selection")
    p_config.add_argument("--model", required=True, help="Model ref, e.g. opencode-cli/opencode/deepseek-v4-flash-free")
    p_config.add_argument("--thinking", default="low", choices=sorted(THINKING_LEVELS))
    p_config.set_defaults(func=command_configure)

    p_run = sub.add_parser("run", help="Run an approved delegated Pi task")
    p_run.add_argument("--approved", action="store_true", help="Required after explicit user approval")
    p_run.add_argument("--task-file", help="File containing delegated prompt")
    p_run.add_argument("--task", help="Delegated prompt text")
    p_run.add_argument("--cwd", default=os.getcwd(), help="Target working directory")
    p_run.add_argument("--model", help="Model ref. Defaults to free/recommended/configured model")
    p_run.add_argument("--thinking", choices=sorted(THINKING_LEVELS))
    p_run.add_argument("--complexity", choices=["simple", "medium", "complex"], default="medium")
    p_run.add_argument("--tools", help="Pi tool allowlist, e.g. read,bash,edit,write")
    p_run.add_argument("--session-name", default="pi-delegated-task")
    p_run.add_argument("--approve-project", action="store_true", help="Pass --approve to Pi for project-local resources")
    p_run.add_argument("--no-session", action="store_true", help="Do not persist the Pi session")
    p_run.add_argument("--stats-timeout", type=float, default=10.0, help="Seconds to wait for post-run stats")
    p_run.add_argument("--verbose", action="store_true", help="Print raw JSON events")
    p_run.set_defaults(func=command_run)

    return parser


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
