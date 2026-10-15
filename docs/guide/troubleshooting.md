# Troubleshooting

[English](troubleshooting.md) · [Tiếng Việt](troubleshooting.vi.md) · [简体中文](troubleshooting.zh-CN.md)

← [README](../../README.md) · [Installation](installation.md) · [Tool reference](tools.md)

| Problem | What to check |
|---|---|
| `spec-nav` does not connect | Node.js/npm/Git are available to the client; configuration is valid; installation can access GitHub. |
| Wrong projects or no source files | Ask for `spec_nav_services`; check `SPEC_NAV_ROOT` and the `.mcp.json` used by the session. |
| A function is missing | Check [supported languages](languages.md), coverage, catalog filters and the [limits](../../README.md#limits). |
| Search returns no useful candidates | Try alternate English keywords, browse the catalog or use ordinary search. |
| `STALE ID` | Find the function again and read its current ID. |
| Local changes to this MCP do not appear | `npx github:` uses the committed package. Use the [local checkout configuration](installation.md#install-from-a-local-checkout) while developing. |
| Many `unresolved` callers in TS/JS | Install the project's dependencies (`node_modules`); without them library types are unknown. |
| Claude Desktop extension does not start | Check that **Repository to scan** is set and the extension is enabled. See **Settings → Extensions** and the MCP logs under **Settings → Developer**. |
| Claude Desktop scans the wrong repository | Change **Repository to scan** in the extension settings and start a new chat. |
