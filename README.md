# rocket-snake

Reply suggestions for [Rocket.Chat](https://rocket.chat) in the browser, drafted by headless
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) with optional [Onyx](https://onyx.app) internal search.

```
userscript (your Rocket.Chat) --GM_xmlhttpRequest--> server.py (127.0.0.1:8787) --> claude -p [+ Onyx MCP]
```

- The userscript reads the last 30 messages of the current room/thread with your browser session
  and sends them to the local backend. Nothing is ever sent to Rocket.Chat automatically:
  clicking a suggestion only fills the composer.
- The backend runs `claude -p` (your Claude Code subscription), so no API key is needed.

## Requirements

- Claude Code installed and logged in (`claude` on the `PATH`)
- Python 3.10+ (standard library only)
- [Violentmonkey](https://violentmonkey.github.io/) (or Tampermonkey)
- Optional: an Onyx instance with its MCP server enabled and an API key

## Setup

1. Optional config in `~/.config/rocket-snake/env` (`KEY=VALUE` lines, read at startup;
   environment variables take precedence):

   ```sh
   RS_ROCKET_URL=https://chat.mycompany.com
   CLAUDE_CONFIG_DIR=/Users/me/.claude
   RS_PERSONA=an SRE / Cloud Engineer
   RS_ORG=MyCompany
   RS_ONYX=1
   RS_ONYX_URL=https://onyx-mcp.mycompany.com/
   RS_ONYX_KEY_CMD=pass show onyx/mcp_api_key
   ```

2. Run the backend, either in a terminal (`python3 server.py`) or as a macOS LaunchAgent that starts
   at login and restarts on crash, managed with `rsctl`:

   ```sh
   ./rsctl install              # write the LaunchAgent and start it (re-run after moving the repo)
   ./rsctl start | stop | restart | status | logs
   ./rsctl menubar              # optional: SwiftBar menu bar icon (start/stop, usage, logs)
   ./rsctl uninstall [--purge]  # remove the LaunchAgent and menu bar plugin (--purge: config, usage, logs)
   ```

3. Open <http://127.0.0.1:8787/rocket-snake.user.js> and install it in Violentmonkey. The backend serves
   the script with your `RS_ROCKET_URL` as `@match` and itself as `@updateURL`, so Violentmonkey picks up
   new versions automatically.

## Usage

- Suggestions appear as chips inside the empty composer: click to insert, `×` to dismiss,
  `↻` to regenerate, `ⓘ` for usage and versions, `Esc` to close. Typing hides them.
- ✨ button (bottom right) or `Ctrl+Shift+Space` to ask on demand. Text already typed in the
  composer is treated as a draft to improve.
- Auto mode (`AUTO` in the userscript): suggestions load when you open a room, after 1.5 s, only if
  the last message is from someone else, less than 24 h old, and the composer is empty.
  Results are cached per room until a new message arrives.
- Prefetch (`PREFETCH`): every 15 s the userscript checks for new DMs and mentions and drafts
  suggestions in the background (same guards). The button badge counts rooms with suggestions ready.
- Onyx (`ONYX` in the userscript, `RS_ONYX=1` on the backend): a second call runs in parallel and adds
  up to 2 replies labelled ONYX, with their sources, when the conversation needs internal knowledge.
- Script and server versions are shown under `ⓘ` (⚠️ and an orange `!` badge when they differ).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RS_PORT` | `8787` | Backend port (127.0.0.1 only) |
| `RS_MODEL` | `sonnet` | Model passed to `claude -p` |
| `RS_ROCKET_URL` | | Rocket.Chat URL injected as `@match` in the served userscript |
| `RS_PERSONA` | `a software engineer` | Who the replies are written for |
| `RS_ORG` | `the company` | Organisation name used in the prompts |
| `RS_ONYX` | `0` | `1` enables Onyx-grounded suggestions |
| `RS_ONYX_URL` | | Onyx MCP endpoint |
| `RS_ONYX_KEY_CMD` | | Shell command printing the Onyx API key |
| `RS_TIMEOUT` | `90` | `claude -p` timeout (seconds) |
| `RS_ONYX_TIMEOUT` | `150` | Timeout of the Onyx-grounded call (seconds) |
| `RS_DAILY_BUDGET_USD` | `2` | Daily API-equivalent budget; auto and prefetch calls are refused above it |
| `RS_USAGE_LOG` | `~/.local/state/rocket-snake/usage.jsonl` | One line per call: kind, cost, duration, tokens (no message content) |
| `RS_ENV_FILE` | `~/.config/rocket-snake/env` | Optional config file |
| `CLAUDE_CONFIG_DIR` | Claude Code default | Claude Code profile used by `claude -p` |

## Notes

- The Onyx MCP server is declared as `onyxkb` with an API key: reusing a name that already has an OAuth
  entry in your Claude Code config ends up `needs-auth` in headless mode.
- Onyx searches are sent with `skip_query_expansion: true`: Claude already writes the query, and
  server-side expansion multiplies the search load.
- Conversation content is sent to Anthropic: keep sensitive rooms (personal or health data) out of it.
