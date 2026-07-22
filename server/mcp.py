"""Manage MCP servers by reading the config files and wrapping `claude mcp`.

Scopes (matching the Claude Code CLI):
- user    (global)          -> ~/.claude.json               "mcpServers"
- local   (per-dir private) -> ~/.claude.json  projects[<dir>].mcpServers
- project (per-dir shared)  -> <dir>/.mcp.json              "mcpServers"

Listing reads the files directly (fast, no health-check spawning). Adding and
removing shell out to `claude mcp add-json` / `claude mcp remove`, which own the
file format.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

CLAUDE_JSON = Path.home() / ".claude.json"
VALID_SCOPES = ("user", "local", "project")
VALID_TRANSPORTS = ("stdio", "http", "sse")


def _claude_cli() -> str:
    override = os.environ.get("CLAUDE_CLI_PATH")
    if override:
        return override
    found = shutil.which("claude")
    if found:
        return found
    raise RuntimeError("claude CLI not found on PATH (set CLAUDE_CLI_PATH).")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _summarize(servers: Optional[dict], scope: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name, cfg in (servers or {}).items():
        cfg = cfg or {}
        if cfg.get("command"):
            transport = "stdio"
            target = cfg["command"]
            if cfg.get("args"):
                target = (target + " " + " ".join(str(a) for a in cfg["args"])).strip()
        else:
            transport = cfg.get("type") or ("http" if cfg.get("url") else "unknown")
            target = cfg.get("url", "")
        out.append({
            "name": name,
            "scope": scope,
            "transport": transport,
            "target": target,
            "env": list((cfg.get("env") or {}).keys()),       # keys only (no secrets)
            "headers": list((cfg.get("headers") or {}).keys()),
        })
    out.sort(key=lambda s: s["name"].lower())
    return out


def _find_project_entry(cwd: str) -> dict[str, Any]:
    """Match cwd against ~/.claude.json project keys (path-normalized)."""
    data = _read_json(CLAUDE_JSON)
    projects = data.get("projects") or {}
    want = os.path.normcase(os.path.normpath(cwd))
    for key, val in projects.items():
        if os.path.normcase(os.path.normpath(key)) == want:
            return val or {}
    return {}


def list_mcp(cwd: Optional[str] = None) -> dict[str, Any]:
    data = _read_json(CLAUDE_JSON)
    result: dict[str, Any] = {
        "global": _summarize(data.get("mcpServers"), "user"),
        "local": [],
        "project": [],
        "cwd": cwd or "",
    }
    if cwd:
        result["local"] = _summarize(_find_project_entry(cwd).get("mcpServers"), "local")
        result["project"] = _summarize(
            _read_json(Path(cwd) / ".mcp.json").get("mcpServers"), "project")
    return result


def list_cli(cwd: Optional[str] = None) -> list[dict[str, Any]]:
    """Run `claude mcp list` and parse it. This is what Claude Code actually
    sees — including claude.ai account connectors — with a health status.
    Slower than reading the files (it health-checks servers)."""
    proc = subprocess.run(
        [_claude_cli(), "mcp", "list"],
        cwd=cwd or None, capture_output=True, text=True, timeout=60,
    )
    servers: list[dict[str, Any]] = []
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("checking mcp"):
            continue
        name, sep, rest = line.partition(": ")
        if not sep:
            continue
        target, dash, status_text = rest.rpartition(" - ")
        if not dash:
            target, status_text = rest, ""
        low = status_text.lower()
        if "auth" in low:
            status = "needs-auth"
        elif "fail" in low or "✗" in status_text:
            status = "failed"
        elif "connect" in low or "✓" in status_text:
            status = "connected"
        else:
            status = "unknown"
        servers.append({
            "name": name.strip(),
            "target": target.strip(),
            "status": status,
            "statusText": status_text.strip(),
        })
    return servers


def _run_mcp(args: list[str], cwd: Optional[str] = None) -> None:
    proc = subprocess.run(
        [_claude_cli(), "mcp", *args],
        cwd=cwd or None, capture_output=True, text=True, timeout=45,
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
        raise RuntimeError(msg)


def add_mcp(name: str, scope: str, transport: str, command: str, args: list[str],
            url: str, env: dict[str, str], headers: dict[str, str],
            cwd: Optional[str] = None) -> dict[str, Any]:
    name = (name or "").strip()
    if not name or " " in name:
        raise ValueError("Server name is required and cannot contain spaces.")
    if scope not in VALID_SCOPES:
        raise ValueError(f"scope must be one of {VALID_SCOPES}")
    if transport not in VALID_TRANSPORTS:
        raise ValueError(f"transport must be one of {VALID_TRANSPORTS}")
    if scope in ("local", "project") and not cwd:
        raise ValueError("A directory is required for local/project scope.")

    if transport == "stdio":
        if not command.strip():
            raise ValueError("Command is required for a stdio server.")
        config: dict[str, Any] = {"command": command.strip()}
        if args:
            config["args"] = args
        if env:
            config["env"] = env
    else:
        if not url.strip():
            raise ValueError("URL is required for an http/sse server.")
        config = {"type": transport, "url": url.strip()}
        if headers:
            config["headers"] = headers

    _run_mcp(["add-json", name, json.dumps(config), "-s", scope], cwd=cwd)
    return {"name": name, "scope": scope}


def remove_mcp(name: str, scope: str, cwd: Optional[str] = None) -> dict[str, Any]:
    if scope not in VALID_SCOPES:
        raise ValueError(f"scope must be one of {VALID_SCOPES}")
    if scope in ("local", "project") and not cwd:
        raise ValueError("A directory is required for local/project scope.")
    _run_mcp(["remove", name, "-s", scope], cwd=cwd)
    return {"name": name, "scope": scope}
