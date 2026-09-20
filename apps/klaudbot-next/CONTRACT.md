# HTTP / SSE implementation map

Client: `/Users/portal/Projects/klaudbot-next-ultra/lib/api.ts`.
Proxy: `/Users/portal/Projects/klaudbot-next-ultra/lib/server-proxy.ts`.
Handler: `/Users/portal/Projects/klaudbot-next-ultra/app/[...path]/route.ts`.

| Method and path | Client / behavior |
| --- | --- |
| GET `/health` | `health()`; actual upstream JSON, no manufactured health, no authentication |
| GET `/state` | `state()`; validated shell/prefs/bots/approvals; avatar sidecar data retained |
| POST `/state` | `patchShell(patch)` sends `{patch}` with RFC 6902 shell-relative operations |
| GET `/bots` | `bots()`; roster fetch, does not erase `/state` avatar data |
| POST `/bots` | `createBot(name)` sends **only `{name}`**, waits for returned id |
| PATCH `/bots/:id` | `avatar(id, avatar)` sends `{avatar}` separately |
| POST `/prefs` | `pref(id)` sends `{key:"lastBotId",value:id}` |
| GET `/settings` | `settings()`; `{bashApproval,reasoningEffort}` only |
| POST `/settings` | `saveSettings(patch)`; server owns whitelist storage; returned policy synchronizes device `rein.klaud.approve` |
| GET `/activity` | `activity()`; real endpoint, polls while visible, no fake autonomy |
| GET `/bots/:id/inspect-list` | `inspectList(id)`; cwd file listing, safety/size filtering |
| GET `/bots/:id/inspect?path=` | `inspect(id,path)`; query first and query-only basename fallback with spaces preserved |
| POST `/run` | `run(bot,message,signal,onEvent)`; threadId from **bot.sessionId**; four frontend tool declarations |
| POST `/runs/:id/cancel` | `cancel(id)`; immediate disconnect also cancels a pre-header run |
| POST `/runs/:id/approvals/:id` | `approve(run,id,allow)` sends exactly `{allow:boolean}` |
| POST `/runs/:id/tools/:id` | `toolResult(run,id,result,isError)` sends `{result:string,isError:boolean}` |
| GET `/bots/:id/messages?before=` | Existing paginated history; id-aware merge and local/durable aliases |

SSE passes as `text/event-stream`, no compression, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`. The proxy uses native Node HTTP(S) with no socket inactivity timeout; it does not use a fetch implementation with an implicit long-response deadline. It retains streaming backpressure, forwards cancellation, and does not buffer `/run`. No route maxDuration is set. Tests prove incremental delivery and cancellation; a multi-hour live soak was not run.

Client parsing supports UTF-8 chunk boundaries, CRLF split across chunks, multiline `data:`, comments, terminal events, and `[DONE]`. Premature termination is a real connection fault. Handler errors never reflect raw upstream headers or credentials.

Handled public AG-UI events: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STATE_SNAPSHOT`, `STATE_DELTA`, `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END/RESULT`; custom `klaud.approval`, `klaud.frontend_tool`, `klaud.progress`. Provider thinking payloads are not displayed. Path describes public tool records, not private chain-of-thought.

Frontend tools: `patchShell` validates and persists a patch; `setPref` selects an existing bot; `navigateTo` accepts only bots/chat/settings; `confirmAction` displays in-app controls and responds to the tool-result endpoint. Frontend work does not block the SSE reader. Pending action ids are reconciled when server snapshots remove timed-out or settled approvals.

The harness follows shell deltas with complete snapshots. The client validates delta routing but adopts the authoritative following snapshot instead of replaying RFC 6902 `test` operations over a possibly newer HTTP response; separate HTTP and SSE channels can arrive out of order. Historical pages retain chronological anchors, while local ids alias durable ids and same-turn streamed text blocks join exactly as the harness joins them.

Approval policy mirrors existing behavior: always bypasses mutating guard waits; auto bypasses Bash; whitelist allows tools as created and records names server-side; ask requires operator decisions. Client policy is not a new server authorization system. Selecting Whitelist / Always allow persists the mode before allowing the pending action; errors retain the action for retry.