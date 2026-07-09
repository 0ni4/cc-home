"""WebSocket chat: runs the claude CLI via claude-agent-sdk.

Because it wraps the CLI, the corporate LLM gateway settings (ANTHROPIC_BASE_URL
etc.) configured on the CLI side are inherited as-is.

Protocol (client -> server):
  {"type": "start", "cwd": str, "resume"?: str, "permissionMode"?: str, "model"?: str}
  {"type": "user", "text": str}
  {"type": "permission_response", "requestId": str, "allow": bool}
  {"type": "interrupt"}

(server -> client):
  {"event": "ready"}
  {"event": "init", "sessionId": str, "model": str}
  {"event": "delta", "text": str}
  {"event": "assistant", "blocks": [...]}
  {"event": "tool_use", "id": str, "name": str, "input": str}
  {"event": "tool_result", "id": str, "text": str, "isError": bool}
  {"event": "permission_request", "requestId": str, "tool": str, "input": str}
  {"event": "result", "sessionId": str, "costUsd": float, "numTurns": int, ...}
  {"event": "error", "message": str}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import uuid as uuid_mod
from pathlib import Path
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    AssistantMessage,
    SystemMessage,
    UserMessage,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    PermissionResultAllow,
    PermissionResultDeny,
)

try:
    from claude_agent_sdk import StreamEvent  # partial streaming (may be absent in some SDK versions)
except ImportError:  # pragma: no cover
    StreamEvent = None

log = logging.getLogger("chat")

PERMISSION_TIMEOUT_S = 300


def resolve_cli_path() -> str | None:
    """Path to the claude CLI to run, or None to let the SDK use its bundled one.

    Frozen (PyInstaller) builds do not ship the SDK's bundled claude executable
    (it is ~235MB), so there we locate an installed CLI. `CLAUDE_CLI_PATH`
    always wins if set.
    """
    override = os.environ.get("CLAUDE_CLI_PATH")
    if override:
        return override
    if getattr(sys, "frozen", False):
        found = shutil.which("claude")
        if found:
            return found
        exe = "claude.exe" if os.name == "nt" else "claude"
        candidate = Path.home() / ".local" / "bin" / exe
        if candidate.exists():
            return str(candidate)
    return None


def _dump_input(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, indent=2)[:4000]
    except (TypeError, ValueError):
        return str(data)[:4000]


class ChatSession:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.client: ClaudeSDKClient | None = None
        self.pending_permissions: dict[str, asyncio.Future] = {}
        self.session_id: str = ""

    async def send(self, payload: dict[str, Any]) -> None:
        try:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:  # ignore sends after disconnect
            pass

    # ---- permission callback (invoked by the SDK) ----
    async def can_use_tool(self, tool_name: str, tool_input: dict, context: Any):
        request_id = str(uuid_mod.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending_permissions[request_id] = fut
        await self.send({
            "event": "permission_request",
            "requestId": request_id,
            "tool": tool_name,
            "input": _dump_input(tool_input),
        })
        try:
            allow = await asyncio.wait_for(fut, timeout=PERMISSION_TIMEOUT_S)
        except asyncio.TimeoutError:
            allow = False
        finally:
            self.pending_permissions.pop(request_id, None)
        if allow:
            return PermissionResultAllow()
        return PermissionResultDeny(message="Denied by the user in the GUI")

    # ---- forwarding loop: claude -> ws ----
    async def pump(self) -> None:
        assert self.client is not None
        try:
            async for msg in self.client.receive_messages():
                await self._forward(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("pump error")
            await self.send({"event": "error", "message": f"{type(e).__name__}: {e}"})

    async def _forward(self, msg: Any) -> None:
        if isinstance(msg, SystemMessage):
            if getattr(msg, "subtype", "") == "init":
                data = getattr(msg, "data", {}) or {}
                self.session_id = data.get("session_id", "") or self.session_id
                await self.send({
                    "event": "init",
                    "sessionId": self.session_id,
                    "model": data.get("model", ""),
                    "cwd": data.get("cwd", ""),
                })
        elif StreamEvent is not None and isinstance(msg, StreamEvent):
            ev = getattr(msg, "event", {}) or {}
            if ev.get("type") == "content_block_delta":
                delta = ev.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    await self.send({"event": "delta", "text": delta["text"]})
        elif isinstance(msg, AssistantMessage):
            blocks = []
            for b in getattr(msg, "content", []) or []:
                if isinstance(b, TextBlock):
                    blocks.append({"t": "text", "text": b.text})
                elif isinstance(b, ThinkingBlock):
                    blocks.append({"t": "thinking", "text": getattr(b, "thinking", "")})
                elif isinstance(b, ToolUseBlock):
                    await self.send({
                        "event": "tool_use",
                        "id": b.id,
                        "name": b.name,
                        "input": _dump_input(b.input),
                    })
            if blocks:
                await self.send({"event": "assistant", "blocks": blocks})
        elif isinstance(msg, UserMessage):
            content = getattr(msg, "content", None)
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, ToolResultBlock):
                        text = b.content if isinstance(b.content, str) else _dump_input(b.content)
                        await self.send({
                            "event": "tool_result",
                            "id": b.tool_use_id,
                            "text": (text or "")[:4000],
                            "isError": bool(getattr(b, "is_error", False)),
                        })
        elif isinstance(msg, ResultMessage):
            self.session_id = getattr(msg, "session_id", "") or self.session_id
            await self.send({
                "event": "result",
                "sessionId": self.session_id,
                "isError": bool(getattr(msg, "is_error", False)),
                "costUsd": getattr(msg, "total_cost_usd", None),
                "numTurns": getattr(msg, "num_turns", None),
                "durationMs": getattr(msg, "duration_ms", None),
                "resultText": getattr(msg, "result", None),
            })

    # ---- main handler ----
    async def run(self) -> None:
        start = await self.ws.receive_json()
        if start.get("type") != "start":
            await self.send({"event": "error", "message": "The first message must be of type 'start'"})
            return

        opts_kwargs: dict[str, Any] = {
            "cwd": start.get("cwd") or None,
            "permission_mode": start.get("permissionMode") or "acceptEdits",
            "can_use_tool": self.can_use_tool,
            # behave like the real Claude Code (tool guidance, language mirroring)
            # rather than a raw agent, which otherwise sometimes replies in English
            "system_prompt": {"type": "preset", "preset": "claude_code"},
            # read user/project settings (CLAUDE.md, MCP, etc.) like normal claude code
            "setting_sources": ["user", "project", "local"],
        }
        cli_path = resolve_cli_path()
        if cli_path:
            opts_kwargs["cli_path"] = cli_path
        if start.get("resume"):
            opts_kwargs["resume"] = start["resume"]
        if start.get("model"):
            opts_kwargs["model"] = start["model"]
        if StreamEvent is not None:
            opts_kwargs["include_partial_messages"] = True

        try:
            options = ClaudeAgentOptions(**opts_kwargs)
        except TypeError:
            # SDK version differences: drop unsupported kwargs and retry
            opts_kwargs.pop("include_partial_messages", None)
            options = ClaudeAgentOptions(**opts_kwargs)

        self.client = ClaudeSDKClient(options)
        try:
            await self.client.connect()
        except Exception as e:
            log.exception("connect failed")
            await self.send({"event": "error", "message": f"Failed to start claude: {e}"})
            return

        pump_task = asyncio.create_task(self.pump())
        await self.send({"event": "ready"})
        try:
            while True:
                data = await self.ws.receive_json()
                mtype = data.get("type")
                if mtype == "user":
                    text = data.get("text", "")
                    if text.strip():
                        await self.client.query(text)
                elif mtype == "permission_response":
                    fut = self.pending_permissions.get(data.get("requestId", ""))
                    if fut is not None and not fut.done():
                        fut.set_result(bool(data.get("allow")))
                elif mtype == "interrupt":
                    try:
                        await self.client.interrupt()
                    except Exception as e:
                        await self.send({"event": "error", "message": f"interrupt failed: {e}"})
        except WebSocketDisconnect:
            pass
        finally:
            pump_task.cancel()
            for fut in self.pending_permissions.values():
                if not fut.done():
                    fut.set_result(False)
            try:
                await self.client.disconnect()
            except Exception:
                pass


async def handle_chat_ws(ws: WebSocket) -> None:
    await ws.accept()
    session = ChatSession(ws)
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("chat ws error")
        await session.send({"event": "error", "message": f"{type(e).__name__}: {e}"})
