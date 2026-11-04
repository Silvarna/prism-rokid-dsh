# DeepSeek Harness Prism adapter

PluginBridge v4 adapter for DeepSeek Harness (DSH). Version 0.3.0 reads persisted DSH sessions and model selections, sends to an already open desktop session through a small DSH-side companion, forwards live text chunks into Prism history turns, exposes DSH's model catalog and model switching, and accepts remote selection of known DSH conversations. It falls back to DSH ACP for new or inactive sessions.

## Local setup

The companion is in `../dsh-prism-companion`. It must be loaded by the DSH desktop profile before this adapter is updated. See its README for the exact profile change and restart. The adapter uses the Hub-managed Node 22 runtime. Its DSH data directory is selected from `PRISM_DSH_HOME`, the parent plugin's `config.json` field `dsh_home`, then `DSH_HOME`. Without a configured path it checks `~/.dsh` and drive-root `.dsh` directories on Windows, preferring a home with a companion descriptor. A relocated home can be selected with `~/.prism/pluginbridge-plugins/dsh/config.json` containing, for example, `{ "dsh_home": "D:\\DSH-data" }`; restart Prism Hub after changing it. The adapter reads the companion descriptor from the selected home, connects only to `127.0.0.1`, and sends its random bearer token. The companion does not expose the DSH Host's own authentication token.

On Windows, the ACP fallback searches the standard Program Files locations on available drive letters and the user's Local AppData Programs directory. Set `PRISM_DSH_APP_PATH` to the absolute `DeepSeek Harness.exe` path for a custom installation, or `PRISM_DSH_COMMAND` to select a CLI. On non-Windows systems, set `PRISM_DSH_NODE` to Node 24+ to decode history.

## Behavior and limits

The adapter lists persisted v4 sessions, reads text history and the selected model from DSH's projection cache, and sends text to the live desktop Agent when available. The live companion rejects a busy Agent and deduplicates requests by message ID. A desktop-owned send is reported as native-visible after the Agent accepts it; completion is checked through the companion and response text is read from DSH history. The companion exposes DSH's model catalog for current and historical sessions. For an inactive session, it resumes the native session temporarily to record a model change, then releases it. Selecting a conversation in Prism verifies that it is in DSH's native session directory and does not change the DSH desktop foreground. It does not support attachments, permission approvals, or interrupting a desktop-owned run. ACP permission requests are cancelled, never automatically approved.

ACP alone cannot resume a session whose writer is held by the DSH desktop process. If the companion is not loaded, that session remains read-only in Prism. The companion must be installed in the desktop profile and DSH restarted to load it; no manual conversation migration is required. Live previews are replaced by the final persisted reply when the run completes.

## Verification

Run `node --test test/*.test.js` with Node 22. The companion has its own tests and an isolated installed-DSH smoke test. The latter launches the installed DSH ACP profile with a temporary home and verifies that the companion loads and answers an authenticated health check; it does not send a model prompt.

## 0.3.0

- **Pick the DSH folder**: `node scripts/pick-dsh-home.js` opens a folder picker (Windows/macOS) and saves `dsh_home`; pass a path as argument instead, or `--show` to see what is used. The folder may be `.dsh` itself or its parent. `DSH_HOME` saved in the user environment (Windows registry / `launchctl setenv`) is read even when Prism Hub started before it was set. An invalid source falls through to the next one instead of failing.
- **Connection**: history and the session list decode Zstandard in-process (Node 22.15+), no DSH process per read; decoded threads are cached by file mtime/size. ACP is only started when the companion is not reachable, with a 10 s initialize timeout and its stderr in the error. The plugin stays Available (read-only) when a DSH folder exists. macOS app path supported.
- **Thread**: rows get strictly increasing times in file order (no 1970 rows, no reply-before-question ties); consecutive assistant rows of one turn are merged into one reply; desktop user kinds accepted (override with `PRISM_DSH_USER_KINDS`).
- **Diagnostics**: `~/.prism-dsh/plugin.log`; `node scripts/diagnose.js [session-id]` writes `~/.prism-dsh/diagnose.txt`.
