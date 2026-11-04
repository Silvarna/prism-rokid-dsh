# Prism companion for DSH desktop

This tiny DSH plugin exposes a loopback-only HTTP endpoint to the Prism adapter. It looks up a live Agent by session ID and delivers text with `agent.followup`. It does not use or expose DSH Host credentials. Requests require a random token written to the user's DSH home in `prism-companion.json`; the server binds only `127.0.0.1`, rejects unknown sessions and busy agents, and deduplicates message IDs.

## Install

Set `DSH_HOME` to the DSH data directory currently used by the desktop application. Append the contents of `desktop.patch.yml` to `%DSH_HOME%\profiles\desktop\cordis.patch.yml`, after backing up that file. Replace the `name` path in the patch with the absolute path to this companion's `index.js` on the target machine. Restart the DeepSeek Harness desktop application so the desktop profile loads the plugin. The DSH desktop CLI is managed by the Electron app, so use the desktop profile patch rather than `dsh plugin --profile desktop add`.

After the descriptor appears in `%DSH_HOME%\prism-companion.json`, install or activate the sibling Prism adapter v0.2.7 and refresh the Prism Hub plugin library. Configure the adapter to use the same DSH home, as described in its README. The Hub should show the DSH runtime available and remote on. Open an existing DSH desktop conversation in the Prism Panel and send a short message to verify the full path. The companion records DSH's process-local `agent/assistant-stream` text deltas for the live preview and exposes the model catalog and model selection for both active and historical sessions through authenticated loopback endpoints.

To remove the companion, delete only its `prism-companion` insertion from the desktop profile patch and restart DSH. The companion removes its descriptor on clean shutdown.

## Tests

With Node 22, run `node --test test/bridge.test.mjs` for the request protocol and `node test/installed-dsh-smoke.mjs` to load it in an isolated DSH ACP profile. Both tests passed on the installed DSH 0.2.1-rc.5. The installed-DSH smoke test does not touch the user's desktop profile or active conversation.
