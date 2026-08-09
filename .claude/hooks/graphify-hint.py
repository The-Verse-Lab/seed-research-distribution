#!/usr/bin/env python3
"""Graphify orientation hint — PreToolUse hook (modes: file, bash).

Replaces the old inline hook commands, which fired on EVERY matching tool call
and used substring extension matching ('.js' in '.json'/'.jsonl' → fired on
config files, transcripts, and files outside the repo). Rules here:

  1. Fires at most ONCE per session (marker file keyed on session_id) — the
     standing graphify policy lives in CLAUDE.md; the hook is just a reminder.
  2. Exact extension match via endswith, never substring.
  3. Absolute paths outside the project root never fire.
  4. Bash mode: word-boundary grep/rg/ag/ack only (no 'find', no 'ripgrep'
     false hits), and never for commands that already invoke graphify.

Author: Runkai Zhang
"""
import json
import os
import re
import sys

SRC_EXTS = (
    ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".kt", ".swift", ".php",
    ".scala", ".lua", ".sh", ".md", ".rst", ".txt", ".mdx",
)

MSG_FILE = (
    "graphify-out/graph.json exists. Orient with `graphify query \"<question>\"` "
    "(or `graphify explain` / `graphify path`) before broad raw-file exploration; "
    "read files directly when modifying or debugging specific lines. Applies to "
    "subagents doing code exploration too. (Shown once per session.)"
)
MSG_BASH = (
    "graphify-out/graph.json exists. Prefer `graphify query \"<question>\"` over "
    "raw grep for orientation questions; grep directly when modifying or "
    "debugging specific lines. (Shown once per session.)"
)


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "file"
    d = json.load(sys.stdin)
    root = os.path.realpath(d.get("cwd") or os.getcwd())
    if not os.path.isfile(os.path.join(root, "graphify-out", "graph.json")):
        return
    marker = "/tmp/graphify-hint-%s" % d.get("session_id", "nosession")
    if os.path.exists(marker):
        return
    t = d.get("tool_input") or {}

    if mode == "bash":
        cmd = str(t.get("command") or "")
        if "graphify" in cmd:
            return
        if not re.search(r"(?<![\w./-])(grep|rg|ag|ack)(?![\w-])", cmd):
            return
    else:
        def hit(s: str) -> bool:
            if not s or "graphify-out" in s:
                return False
            if os.path.isabs(s) and not os.path.realpath(s).startswith(root + os.sep):
                return False
            return s.rstrip("/").lower().endswith(SRC_EXTS)

        if not any(hit(str(t.get(k) or "")) for k in ("file_path", "pattern", "path")):
            return

    open(marker, "w").close()
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": MSG_BASH if mode == "bash" else MSG_FILE,
    }}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
