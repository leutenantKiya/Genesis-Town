#!/usr/bin/env python3
"""Split the merged baseline (prototype/genesis-town.html) back into separate client files.

Run once to create client/; kept in the repo so the split is reproducible. Script bodies are copied byte for byte.
Usage: python3 -I scripts/split-prototype.py prototype/genesis-town.html client
"""
import re
import sys
from pathlib import Path

NAMES = ['sprites.js', 'engine.js', 'mods/casino.js', 'mods/thief.js', 'mods/police.js', 'mods/combat.js',
         'mods/curfew.js', 'mods/gossip.js', 'mods/agent.js', 'mods/soul.js', 'mods/social.js']


def main(src: str, out: str) -> None:
    html = Path(src).read_text(encoding='utf-8')
    scripts = list(re.finditer(r'<script>\n(.*?)</script>', html, re.S))
    if len(scripts) != len(NAMES):
        sys.exit(f'expected {len(NAMES)} scripts, found {len(scripts)}')
    style = re.search(r'<style>\n(.*?)</style>', html, re.S)
    main_markup = re.search(r'(<main id="app">.*?</main>\n<div id="mroot"></div>\n<div id="toasts"[^\n]*</div>)', html, re.S)
    if not style or not main_markup:
        sys.exit('layout markers not found')
    root = Path(out)
    (root / 'js' / 'mods').mkdir(parents=True, exist_ok=True)
    (root / 'css').mkdir(parents=True, exist_ok=True)
    (root / 'css' / 'game.css').write_text(style.group(1), encoding='utf-8')
    tags = []
    for m, name in zip(scripts, NAMES):
        (root / 'js' / name).write_text(m.group(1), encoding='utf-8')
        tags.append(f'<script src="js/{name}"></script>')
    page = f'''<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Genesis Town</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap">
<link rel="stylesheet" href="css/game.css">
<link rel="stylesheet" href="css/chain.css">
</head>
<body>
{main_markup.group(1)}

<script src="js/flags.js"></script>
{chr(10).join(tags)}
<script src="vendor/near.js"></script>
<script src="js/mods/chain.js"></script>
</body>
</html>
'''
    (root / 'index.html').write_text(page, encoding='utf-8')
    print(f'wrote {len(NAMES)} scripts, css and index.html to {root}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
