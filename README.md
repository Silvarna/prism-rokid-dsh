# Prism plugin for DeepSeek Harness

Prism PluginBridge adapter and DeepSeek Harness desktop companion.

- The adapter files are at the repository root. See [adapter setup](README-adapter.md).
- The companion is in [`dsh-prism-companion/`](dsh-prism-companion/). Load it in the DSH desktop profile before using live session control.
- `config.json`, DSH session data, companion descriptors, and `node_modules` are intentionally excluded.

The adapter supports session discovery and archived-session filtering, history streaming, desktop messages, and model switching. Configure a relocated DSH home with `PRISM_DSH_HOME`, `DSH_HOME`, or `~/.prism/pluginbridge-plugins/dsh/config.json`.
