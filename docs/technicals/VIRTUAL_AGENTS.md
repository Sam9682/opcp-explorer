# Virtual Agents

OPCP-explorer ships AI "virtual agents" that act on a user's cloned applications by driving an
agentic CLI (Amazon Kiro CLI / Q chat, or OVH `shai`) with a prompt built from a context file.
Everything lives in `src/routes/genai_routes.py` (blueprint `genai`, prefix `/api`) and in the
Virtual Agents panel of `templates/dashboard.html`.

Related docs: [API_REFERENCE.md](../API_REFERENCE.md), [USER_GUIDE.md](../USER_GUIDE.md),
[INIT_PLATFORM.md](../INIT_PLATFORM.md) (installs the engines and the `shared` submodule),
[DATABASE.md](./DATABASE.md) (`configuration`, `deployments`, `billing_activities` tables).

## 1. What exists

There are two backend agents and one UI panel:

| Agent | Endpoint | Actions it serves |
|-------|----------|-------------------|
| **Virtual Developer** | `POST /api/request_dev_ai_for_app` | `MODIFY_CODE`, `SPECIFY` |
| **Virtual Operations** | `POST /api/request_ops_ai_for_app` | `START`, `STOP`, `LOGS`, `PS`, `BACKUP_DATABASE`, `RESTORE_DATABASE`, `MAKE_APP_COMPLIANT` |

- **SPECIFY** is not a separate agent: it is the Developer endpoint called with
  `action_operation: "SPECIFY"`. It is meant to turn a short request into a detailed
  specification the user then pastes into a `MODIFY_CODE` request.
- **Virtual Advisor** is not a separate endpoint or UI either: it is the plain Q&A fallback
  prompt of the Operations endpoint ("You are a helpful Virtual Advisor assistant ... Do not
  execute any commands"), used when no action is given or when an unrecognised action has no
  context file (see section 4.2).
- The old "Virtual DevOps Team" panel, `/api/qchat_devops` and `src/automorph_application.py`
  no longer exist. They were replaced by the single unified panel described below.

## 2. Dashboard panel

The panel (`#agentsPanel` / `#virtualAgentsPanel`) is shown only on the **apps** tab of the
dashboard. It contains:

- `#unifiedAppSelect` - one option per application assigned to the user.
- `#unifiedAction` - the action list. It is rebuilt by `checkApplicationStatusForActions()`
  from the hidden `.application_status` field of the selected app card:

  | `application_status` | Allowed actions |
  |----------------------|-----------------|
  | `is_not_cloned` | none (empty list; the app must be cloned first) |
  | `cloned_and_running` | `STOP`, `PS`, `LOGS`, `MODIFY_CODE`, `SPECIFY`, `BACKUP_DATABASE` |
  | `cloned_but_not_running` | `START`, `LOGS`, `MODIFY_CODE`, `SPECIFY`, `RESTORE_DATABASE` |
  | `cloned_but_not_compliant` | `MAKE_APP_COMPLIANT`, `LOGS` |
  | no app selected (page load) | `SPECIFY`, `MODIFY_CODE`, `START`, `STOP`, `LOGS`, `PS` |

- `#unifiedInput` - pre-filled from the selected app and action (translated strings
  `specify_context_request*`, `dev_modify_code_request*`, `ops_exec_request*` in
  `src/config_postgres.py`). The **Send** button stays disabled until an app is selected and the
  text is non-empty; while a request runs it shows an elapsed-time counter and the panel gets a
  loading overlay.
- `#persistentMessageContent` - terminal-style output where streamed chunks are appended.
  Operations output is also mirrored to the dashboard log (`appendLog`).

`sendUnifiedMessageWithText()` routes the request:

| Selected action | Endpoint | `message` prefix sent |
|-----------------|----------|-----------------------|
| `SPECIFY` | `/api/request_dev_ai_for_app` | `[SPECIFY] [APP:<app>] [PATH:<folder>] <text>` |
| `MODIFY_CODE` | `/api/request_dev_ai_for_app` | `[DEVELOPER] [APP:<app>] [PATH:<folder>] <text>` |
| anything else | `/api/request_ops_ai_for_app` | `[ACTION:<action>] [APP:<app>] [PATH:<folder>] <text>` |

The client computes `application_folder` as
`/home/ubuntu/deployments/<username>/<app name lower-cased, spaces to dashes>`. After an
Operations request completes, the action list is refreshed for the app.

## 3. API

Both endpoints require a logged-in session cookie and a JSON body.

### 3.1 Request body

```json
{
  "message": "[ACTION:START] [APP:my-app] [PATH:/home/ubuntu/deployments/alice/my-app] Start it",
  "application_name": "my-app",
  "application_folder": "/home/ubuntu/deployments/alice/my-app",
  "action_operation": "START",
  "agentic_engine": "kiro-cli",
  "agentic_command": ""
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `message` | yes | Stripped; empty -> `400 {"error": "Message required"}`. |
| `application_name` | no | Used for the app id lookup, branch name, billing. |
| `application_folder` | no | Substituted into the prompt. Developer default when empty: `/home/<LINUX_USER_INSTALLATION>/deployments/`. |
| `action_operation` | no | Action name; selects `<ACTION>_context.md`. |
| `agentic_engine` | no | Overrides the configured engine (see 5). The dashboard never sends it. |
| `agentic_command` | no | Overrides the configured command (see 5). The dashboard never sends it. |

Errors returned before streaming starts (plain JSON):

- `401 {"error": "Authentication required"}` - no `user_id` in session.
- `400 {"error": "Message required"}`.

### 3.2 Streaming response

On success the response is `text/event-stream` (headers `Cache-Control: no-cache`,
`X-Accel-Buffering: no`; the Operations endpoint also sends `Connection: keep-alive`). Each event
is a single `data:` line holding one JSON object:

```text
data: {"chunk": "Starting Agentic AI Developer session..."}
data: {"chunk": "<one line of engine output, ANSI codes stripped>"}
data: {"error": "<message>"}
data: {"done": true, "success": true, "returncode": 0}
```

- `chunk` - progress or engine output. Lines containing `Thinking...` are dropped.
- `error` - a failure. Some errors end the stream without a `done` event (engine not found,
  failure to start the process, exception in the generator).
- `done` - final event; `success` is `returncode == 0`. `returncode` is `null` when an
  Operations action was refused because its context file is missing.

The dashboard reads the body with `fetch()` + `ReadableStream` (not `EventSource`, which cannot
POST).

## 4. Prompt construction

### 4.1 Context files

Prompts come from Markdown templates in the `shared` git submodule:

```
/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/shared/<ACTION>_context.md
```

The submodule is added by `init_pltf.sh` from `SUBMODULE_URL` and refreshed by
`scripts/update_swautomorph_submodules.sh`. `<ACTION>` is `action_operation` upper-cased and
sanitised to `[A-Z0-9_]` (max 50 characters) to prevent path traversal. Examples:
`MODIFY_CODE_context.md`, `SPECIFY_context.md`, `START_context.md`, `STOP_context.md`,
`LOGS_context.md`, `PS_context.md`, `RESTORE_DATABASE_context.md`.

Placeholders replaced in the template:

| Placeholder | Developer | Operations | Value |
|-------------|:---------:|:----------:|-------|
| `{{USER_ID}}` | yes | yes | session `user_id` |
| `{{USER_NAME}}` | yes | yes | `first_name last_name` |
| `{{USER_EMAIL}}` | yes | yes | user email |
| `{{TAIL_LINES}}` | yes | yes | `100` |
| `{{APPLICATION_FOLDER}}` | yes | yes | request `application_folder` |
| `{{APPLICATION_NAME}}` | yes | yes | request `application_name` |
| `{{REPO_GITEA_URL}}` | yes | - | local Gitea URL for the branch (see 6) |
| `{{BRANCH_NAME}}` | yes | - | see 6 |
| `{{REPO_GITHUB_URL}}` | yes | - | GitHub SSH URL built from the app name |
| `{{MESSAGE}}` | yes | - | request `message` |

The Operations prompt does not include the user's message when a context file is used; the
action itself drives the prompt.

### 4.2 Operations: executing vs advisor mode

`return_prompt_for_operator()` returns `(prompt, is_executing)`:

| Situation | Result |
|-----------|--------|
| `action_operation` empty | Advisor Q&A prompt built from `message`; `is_executing = False`. |
| `action_operation` contains `MODIFY_CODE` | Stream `error` "should be sent to Developer agent"; engine not started. |
| Context file found | Template prompt; `is_executing = True`. |
| Missing context, action in `RECOGNIZED_OPERATOR_ACTIONS` (`START`, `STOP`, `LOGS`, `PS`, `SPECIFY`, `RESTORE_DATABASE`) | Explicit failure: `error` event, then `done` with `success: false`, `returncode: null`; engine not started. |
| Missing context, any other action (e.g. `BACKUP_DATABASE`, `MAKE_APP_COMPLIANT`) | Advisor Q&A prompt; `is_executing = False`. |

### 4.3 Prompt logs

| File (under `logs/`) | Written by |
|----------------------|------------|
| `genai_routes.log` | both endpoints (module logger, also to console) |
| `dev_prompt_generated.txt` | both endpoints append every generated prompt |
| `ope_prompts_generated.log` | Operations endpoint, with a timestamp header |

## 5. Engine selection

Resolution order, identical for both endpoints:

1. `agentic_command` from the request body, else the `configuration` row
   `key = 'agentic_command'` with `parent IS NULL`, else `''`.
   If non-empty, the platform runs
   `/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>/deployControlPlan.sh <agentic_command>`
   instead of an AI engine.
2. Otherwise `agentic_engine` from the request body, else the `configuration` row
   `key = 'agentic_engine'`, else `AI_ENGINE` from `src/config_postgres.py` (default
   `'kiro-cli'`).
3. If the engine is `shai` (case-insensitive): `get_shai_paths()` then
   `shai -p "<prompt>"` (headless mode of shai 0.2.2; the old `shai chat` subcommand no longer
   exists).
4. Any other value: `get_qchat_paths()` then `<cmd> chat --trust-all-tools "<prompt>"`.

Binary discovery (first candidate whose `--version` exits 0, each probe limited by
`TIMEOUT_SUBPROCESS_RUN = 600` s):

- `get_qchat_paths()`: `~/.local/bin/qchat`, `/usr/local/bin/qchat`, `/usr/bin/qchat`, `qchat`,
  then the same four locations for `kiro-cli`.
- `get_shai_paths()`: `~/.local/bin/shai`, `/home/<LINUX_USER_INSTALLATION>/.local/bin/shai`,
  `/usr/local/bin/shai`, `/usr/bin/shai`, `shai`.

The engine runs with `HOME=/home/<LINUX_USER_INSTALLATION>`, `USER=<LINUX_USER_INSTALLATION>` and
`~/.local/bin` prepended to `PATH`, in its own process group, stdout and stderr merged.

When the `configuration` table is empty at database initialisation,
`src/database_postgres.py` seeds `agentic_engine = AI_ENGINE`, `agentic_command = ''` and
`runtime_type = 'runc'`. Admins (see `src/admin_auth.py`) change these rows from the dashboard
configuration screen or with `GET/POST /api/configuration` and
`PUT/DELETE /api/configuration/<param_id>`.

## 6. Developer specifics

- Branch name: `<user_id>-automorph-<application_name>-<YYYYmmdd-HHMMSS>`.
- `REPO_GITEA_URL`: `http://<gitea user>:<password>@localhost:3000/gitadmin/<branch_name>`
  (credentials are hardcoded in the route).
- After a `MODIFY_CODE` run that exits 0 with an `application_name`, the latest
  `deployments` row of that user/app is updated: `gitea_branch_url` is set and an entry
  `{timestamp, branch_name, gitea_url, user, message[:200]}` is appended to
  `modification_history` (JSONB). The platform itself does not create the branch; that is left
  to the instructions in `MODIFY_CODE_context.md`.

## 7. Timeouts and termination

Defined in `src/config_postgres.py`:

| Constant | Value | Use |
|----------|-------|-----|
| `TIMEOUT_request_dev_ai_for_app_RUN` | 1800 s | Developer run |
| `TIMEOUT_QCHAT_OPERATOR_RUN` | 1800 s | Operations run |
| `TIMEOUT_CLEAN_SHUTDOWN` | 60 s | final `process.wait()` |
| `TIMEOUT_SUBPROCESS_RUN` | 600 s | `--version` probes |

The elapsed time is checked each time the engine prints a line. Past the limit the process group
gets `SIGTERM`, then `SIGKILL` after 5 s if still alive. If the final wait times out the group is
killed and `returncode` is reported as `-1`.

## 8. Billing

The Operations endpoint calls `billing_routes.record_billing_activity(user_id, app, action)` only
when all of these hold: the action is `START` or `STOP`, the prompt came from a real context file
(`is_executing`), the engine exited 0, and `application_name` is set. `START` inserts a
`billing_activities` row; `STOP` closes the latest open `START` row and computes duration and
cost from `application_costs.cost_per_day`. Advisor answers are never billed.

## 9. Tests

`tests/test_shai_subcommand_bug_condition.py` and `tests/test_shai_subcommand_preservation.py`
statically parse `genai_routes.py` (AST) and check the command shapes: `shai` sites build
`[engine_cmd, '-p', l_prompt]`, the qchat/Kiro sites keep `chat --trust-all-tools`, the
`agentic_command` sites call `deployControlPlan.sh`, and a missing `shai` binary returns before
`Popen`. See [TESTING.md](./TESTING.md).
