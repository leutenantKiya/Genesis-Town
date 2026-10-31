# Baseline (pre-hackathon tag)

This folder is the starting point for the NEAR HACKATHON work. Everything after the `pre-hackathon` tag is the hackathon
NEAR integration and economy redesign.

| Fact | Value |
| --- | --- |
| File | `prototype/genesis-town.html` (single self-contained page, 519,028 bytes, 10,491 lines) |
| Source | Published claude.ai artifact "Genesis Town", version `1792914254-ad3f` |
| Version time | 2026-10-25 07:44:14 UTC (inside the code window that opened 2026-10-19, see HACKATHON.md Q-001) |
| SHA-256 | `267a0f048b57617e1b55c71a8eb5878604914787b6b78fb47ef3bbea1b661aee` |
| Committed unchanged | yes, byte for byte |

What it contains: engine + plugin API `window.GT`, procedural sprites, and the mods casino, thief, police, combat,
curfew, gossip, agent, soul and social, all merged into one HTML file. No blockchain code.

Known gap: the prototype kept being developed until 2026-10-31 in a local source folder (split `sprites.js`,
`game.html`, `mods/*.js`, Playwright suites). That folder was not available when this repository was created, so the
baseline is the 2026-10-25 published build. Later prototype changes are not in this repository unless re-added in a
separately labelled commit.

The prototype is mostly AI-generated code (disclosed per HACKATHON.md Q-005).
