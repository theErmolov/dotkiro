# Changelog

## Unreleased

- Distribute custom agents alongside steering and skills — `agents/` (shared) and `<type>/agents/` are synced into `.kiro/agents/`
- Agents support both `.md` (markdown subagents) and `.json` (CLI agent configs); type-specific agents are flattened into `.kiro/agents/`

## 0.1.0

Initial release.

- `dotkiro init` — sync shared and type-specific steering files and skills from a central Git repo
- `dotkiro add` — layer additional types without re-syncing shared files
- `dotkiro update` — re-sync all configured types from the remote
- `dotkiro remove` — remove synced files by type or remove everything
- `dotkiro status` — show what's currently synced
- Manifest tracking (`.dotkiro-manifest.json`) to manage synced files
- `.dotkirorc` project config with layered resolution (defaults → user → project → CLI flags)
- `--gitignore` flag to auto-exclude the manifest from source control
- `--branch` flag for pinning to a specific branch
