# cc-home

A desktop GUI to browse, search, and resume your Claude Code sessions —
an alternative to opcode.

It wraps the `claude` CLI instead of calling the API directly, so it works
behind an external LLM gateway, inheriting whatever the CLI is configured with.

## Features

- **Session browser** — project → session list read straight from
  `~/.claude/projects` (title, last prompt, branch, PR link, tag).
- **Transcript viewer** — Markdown history with collapsible tool calls and
  thinking; paged loading for large sessions.
- **Full-text search** — search across all sessions with highlighted snippets.
- **Session stats** — token counts, models used, and reply count per session.
- **Skills tab** — browse installed skills (personal + plugins); click one to run
  it (`/skill`) in a session, with the output shown in the transcript.
- **MCP tab** — view and manage MCP servers per scope (global, per-directory
  private, and shared `.mcp.json`); add and remove servers from the GUI. It also
  merges in what `claude mcp list` reports — health status and claude.ai account
  connectors.
- **Settings** (gear, bottom-left) — defaults for model, permission mode, send
  key, working directory, UI scale, and an optional Claude CLI path.
- **Session actions** — rename, tag, fork, and delete from a per-session menu.
- **Resume / new session** — resume a session or start a new one in any directory.
- **Model selection** — choose a model when starting or resuming.
- **Live chat** — streaming responses, interrupt, per-turn cost, and in-GUI
  tool-permission prompts.
- **Auto-refresh** — the sidebar updates when sessions change on disk (e.g. when
  run from the CLI separately).

## Requirements

- Windows + WebView2 (bundled with Windows 11)
- Python 3.10+
- Claude Code CLI already set up (authenticated)

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## Run

```powershell
.\.venv\Scripts\python app.py            # desktop window
.\.venv\Scripts\python app.py --browser  # open in the default browser
.\.venv\Scripts\python app.py --port 9000
```

Or double-click `start.bat`.

## Build a standalone .exe

```powershell
.\.venv\Scripts\pip install pyinstaller
.\.venv\Scripts\pyinstaller cc-home.spec --noconfirm
```

This produces a single `dist\cc-home.exe` (~22MB) that launches as a desktop
window — no Python install needed to run it. It does **not** bundle the Claude
Code CLI, so an installed `claude` must be on `PATH` (or set `CLAUDE_CLI_PATH`).
Edit the `ONEFILE` / `CONSOLE` flags at the top of `cc-home.spec` for a folder
build or a debug console.

## Architecture

```
app.py                 launcher (runs uvicorn in a thread + a pywebview window)
server/
  main.py              FastAPI routing (REST + WebSocket)
  sessions.py          JSONL parser for ~/.claude/projects + full-text search (cached)
  manage.py            rename / tag / fork / delete (wraps claude-agent-sdk file ops)
  chat.py              WebSocket chat; runs the claude CLI via claude-agent-sdk
web/
  index.html / style.css / app.js   build-free vanilla JS SPA (no CDN dependencies)
```

### REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | list projects |
| GET | `/api/projects/{pid}/sessions` | list sessions |
| GET | `/api/projects/{pid}/sessions/{sid}` | get transcript (`?before=&limit=`) |
| GET | `/api/search?q=&limit=` | full-text search across all sessions |
| GET | `/api/state` | change signature polled for auto-refresh |
| POST | `/api/projects/{pid}/sessions/{sid}/rename` | `{title}` |
| POST | `/api/projects/{pid}/sessions/{sid}/tag` | `{tag}` (empty clears) |
| POST | `/api/projects/{pid}/sessions/{sid}/fork` | `{title?, upToMessageId?}` → `{newSessionId}` |
| DELETE | `/api/projects/{pid}/sessions/{sid}` | delete a session |
| WS | `/ws/chat` | live chat (new / resume) |

The SDK launches its bundled `claude` executable; set `CLAUDE_CLI_PATH` to use an
already-installed CLI instead.

## Notes

- `bypassPermissions` mode runs every tool without asking — use with care.
- Resuming a session and chatting appends to the same session JSONL.

## License

MIT — see [LICENSE](LICENSE).
