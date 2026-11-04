# Prism plugin for DeepSeek Harness

This repository contains the [Prism PluginBridge adapter](prism-plugin-dsh/) and the [DeepSeek Harness desktop companion](dsh-prism-companion/).

The adapter lists DSH conversations, filters archived conversations, reads and streams history, sends messages to live desktop sessions, and supports model switching. The companion enables access to sessions owned by the desktop application.

For a relocated DSH data directory, configure `PRISM_DSH_HOME`, `DSH_HOME`, or `~/.prism/pluginbridge-plugins/dsh/config.json` with `dsh_home`. See the adapter README for precedence and setup.

Local configuration, DSH session data, companion bearer tokens, and dependencies are not part of this repository.
