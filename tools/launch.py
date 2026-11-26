"""Mainnet launch switch for the website.

    python tools/launch.py --gmec 0x...   publish the $GMEC contract and open mainnet
    python tools/launch.py --gmec 0x... --no-mainnet   publish $GMEC only

Edits site/js/config.js only. Run `node chain/scripts/launch-check.js --mainnet` and
`node chain/scripts/gmec-check.js --mainnet 0x...` first, then commit and push: the server publishes in two minutes.
"""
import argparse
import pathlib
import re

CONFIG = pathlib.Path(__file__).resolve().parent.parent / "site" / "js" / "config.js"

ap = argparse.ArgumentParser()
ap.add_argument("--gmec", required=True, help="the $GMEC contract on Robinhood Chain")
ap.add_argument("--no-mainnet", action="store_true", help="publish $GMEC but keep mainnet closed")
a = ap.parse_args()
if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a.gmec):
    raise SystemExit("--gmec must be a 0x address with 40 hex characters")

s = CONFIG.read_text(encoding="utf-8")
slot = re.compile(r'export const GMEC = \{(\s*)address: (null|"0x[0-9a-fA-F]{40}"), chainId: 4663')
if not slot.search(s):
    raise SystemExit("GMEC slot not found in config.js")
s = slot.sub(lambda m: f'export const GMEC = {{{m.group(1)}address: "{a.gmec}", chainId: 4663', s)
if not a.no_mainnet:
    if "export const MAINNET_OPEN = false;" in s:
        s = s.replace("export const MAINNET_OPEN = false;", "export const MAINNET_OPEN = true;")
    elif "export const MAINNET_OPEN = true;" not in s:
        raise SystemExit("MAINNET_OPEN switch not found in config.js")
CONFIG.write_text(s, encoding="utf-8", newline="\n")
print(f"$GMEC  {a.gmec}")
print(f"mainnet {'stays closed' if a.no_mainnet else 'OPEN'}")
print("next: git commit -am 'Launch mainnet' && git push  (live in about two minutes)")
