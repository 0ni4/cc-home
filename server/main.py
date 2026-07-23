"""cc-home — FastAPI backend."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import sessions, manage, skills, mcp
from .chat import handle_chat_ws

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("api")

# In a PyInstaller build the web assets are unpacked under sys._MEIPASS.
if getattr(sys, "frozen", False):
    WEB_DIR = Path(getattr(sys, "_MEIPASS")) / "web"
else:
    WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="cc-home")


def _valid_sid(session_id: str) -> bool:
    return bool(session_id) and session_id.replace("-", "").isalnum()


class RenameBody(BaseModel):
    title: str


class TagBody(BaseModel):
    tag: Optional[str] = None


class ForkBody(BaseModel):
    title: Optional[str] = None
    upToMessageId: Optional[str] = None


@app.get("/api/projects")
def api_projects():
    return sessions.list_projects()


@app.get("/api/projects/{project_id}/sessions")
def api_sessions(project_id: str):
    return sessions.list_sessions(project_id)


@app.get("/api/search")
def api_search(q: str, limit: int = 60):
    return sessions.search_all(q, limit=limit)


@app.get("/api/state")
def api_state():
    return {"version": sessions.state_version()}


@app.get("/api/skills")
def api_skills():
    return skills.list_skills()


class NewSkillBody(BaseModel):
    name: str
    description: str = ""
    body: str = ""


@app.post("/api/skills/create")
def api_create_skill(body: NewSkillBody):
    try:
        return skills.create_skill(body.name, body.description, body.body)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        log.exception("create skill failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/mcp")
def api_mcp_list(cwd: str = ""):
    try:
        return mcp.list_mcp(cwd or None)
    except Exception as e:
        log.exception("mcp list failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/mcp/live")
def api_mcp_live(cwd: str = ""):
    """What `claude mcp list` reports (health + claude.ai connectors). Slow."""
    try:
        return {"servers": mcp.list_cli(cwd or None)}
    except Exception as e:
        log.exception("mcp live list failed")
        return JSONResponse({"error": str(e)}, status_code=500)


class AddMcpBody(BaseModel):
    name: str
    scope: str = "user"
    transport: str = "stdio"
    command: str = ""
    args: list[str] = []
    url: str = ""
    env: dict[str, str] = {}
    headers: dict[str, str] = {}
    cwd: str = ""


@app.post("/api/mcp")
def api_mcp_add(body: AddMcpBody):
    try:
        return mcp.add_mcp(body.name, body.scope, body.transport, body.command,
                           body.args, body.url, body.env, body.headers, body.cwd or None)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        log.exception("mcp add failed")
        return JSONResponse({"error": str(e)}, status_code=500)


class RemoveMcpBody(BaseModel):
    name: str
    scope: str
    cwd: str = ""


class AuthTerminalBody(BaseModel):
    cwd: str = ""


@app.post("/api/mcp/auth-terminal")
def api_mcp_auth_terminal(body: AuthTerminalBody):
    try:
        return mcp.open_auth_terminal(body.cwd or None)
    except Exception as e:
        log.exception("open auth terminal failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/mcp/remove")
def api_mcp_remove(body: RemoveMcpBody):
    try:
        return mcp.remove_mcp(body.name, body.scope, body.cwd or None)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        log.exception("mcp remove failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/projects/{project_id}/sessions/{session_id}")
def api_transcript(project_id: str, session_id: str,
                   before: Optional[int] = None, limit: int = 200):
    if not _valid_sid(session_id):
        return JSONResponse({"error": "invalid session id"}, status_code=400)
    return sessions.load_transcript(project_id, session_id, before=before, limit=limit)


@app.post("/api/projects/{project_id}/sessions/{session_id}/rename")
def api_rename(project_id: str, session_id: str, body: RenameBody):
    if not _valid_sid(session_id):
        return JSONResponse({"error": "invalid session id"}, status_code=400)
    try:
        manage.rename(project_id, session_id, body.title)
        return {"ok": True, "title": body.title}
    except Exception as e:
        log.exception("rename failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/projects/{project_id}/sessions/{session_id}/tag")
def api_tag(project_id: str, session_id: str, body: TagBody):
    if not _valid_sid(session_id):
        return JSONResponse({"error": "invalid session id"}, status_code=400)
    try:
        manage.set_tag(project_id, session_id, body.tag)
        return {"ok": True, "tag": body.tag or ""}
    except Exception as e:
        log.exception("tag failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/projects/{project_id}/sessions/{session_id}/fork")
def api_fork(project_id: str, session_id: str, body: ForkBody):
    if not _valid_sid(session_id):
        return JSONResponse({"error": "invalid session id"}, status_code=400)
    try:
        new_id = manage.fork(project_id, session_id,
                             title=body.title, up_to_message_id=body.upToMessageId)
        return {"ok": True, "newSessionId": new_id}
    except Exception as e:
        log.exception("fork failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.delete("/api/projects/{project_id}/sessions/{session_id}")
def api_delete(project_id: str, session_id: str):
    if not _valid_sid(session_id):
        return JSONResponse({"error": "invalid session id"}, status_code=400)
    try:
        manage.delete(project_id, session_id)
        return {"ok": True}
    except Exception as e:
        log.exception("delete failed")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    await handle_chat_ws(ws)


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
