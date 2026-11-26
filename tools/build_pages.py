# Puts the shared head links, header and footer (tools/partials/) into every page of the site.
# Idempotent: injected blocks sit between <!-- @name --> ... <!-- /@name --> markers and are replaced on each run.
#   python tools/build_pages.py
import os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
PART = os.path.join(ROOT, "tools", "partials")
read = lambda p: open(p, encoding="utf-8").read()

FAVICON = ("data:image/svg+xml," + (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23000000'/>"
    "<path d='M12 12V6.4a1.6 1.6 0 0 1 1.6-1.6h4.8A1.6 1.6 0 0 1 20 6.4V12h5.6a1.6 1.6 0 0 1 1.6 1.6v4.8a1.6 1.6 0 0 1-1.6 1.6H20v5.6a1.6 1.6 0 0 1-1.6 1.6h-4.8a1.6 1.6 0 0 1-1.6-1.6V20H6.4a1.6 1.6 0 0 1-1.6-1.6v-4.8A1.6 1.6 0 0 1 6.4 12Z' fill='none' stroke='%23FF2D2D' stroke-width='2.4' stroke-linejoin='round'/>"
    "<path d='M16 6.8 18.8 11.2H13.2Z' fill='%23FF2D2D'/></svg>").replace("<", "%3C").replace(">", "%3E"))

FONTS = ('<link rel="preload" href="/fonts/jersey-25.woff2" as="font" type="font/woff2" crossorigin>\n'
         '  <link rel="preload" href="/fonts/pixelify-sans.woff2" as="font" type="font/woff2" crossorigin>\n'
         '  <link rel="stylesheet" href="/css/fonts.css">')
CONNECT = '<button class="btn btn-go btn-sm" type="button" data-connect>Connect wallet</button>'
BRIDGE_LINK = '<a class="btn btn-go btn-sm nav-cta" href="/bridge/"><span data-n="navcta">Get GME gas</span></a>'

PAGES = {
    "index.html":          {"css": ["base", "home"], "cta": BRIDGE_LINK, "nav": None, "body": "page-home"},
    "bridge/index.html":   {"css": ["base", "app"],  "cta": CONNECT,     "nav": "bridge", "body": "page-app", "wallet": True},
    "swap/index.html":     {"css": ["base", "app"],  "cta": CONNECT,     "nav": "swap", "body": "page-app", "wallet": True},
    "explorer/index.html": {"css": ["base", "app"],  "cta": BRIDGE_LINK, "nav": "explorer", "body": "page-app"},
    "docs/index.html":     {"css": ["base", "docs"], "cta": BRIDGE_LINK, "nav": "docs", "body": "page-docs", "wallet": True},
    "roadmap/index.html":  {"css": ["base", "docs"], "cta": BRIDGE_LINK, "nav": "roadmap", "body": "page-docs"},
}

def block(name, html):
    return f"<!-- @{name} -->\n{html}\n<!-- /@{name} -->"

def put(s, name, html, fallback):
    """replace an existing marked block, or the old markup the fallback regex finds (first run)"""
    marked = re.compile(rf"<!-- @{name} -->.*?<!-- /@{name} -->", re.S)
    if marked.search(s):
        return marked.sub(lambda _: block(name, html), s, count=1)
    m = re.search(fallback, s, re.S)
    if not m:
        raise SystemExit(f"cannot place @{name}")
    return s[:m.start()] + block(name, html) + s[m.end():]

def build(rel, cfg):
    p = os.path.join(SITE, rel)
    s = read(p)
    head = "\n  ".join([
        '<meta name="theme-color" content="#000000">',
        f'<link rel="icon" href="{FAVICON}">',
        FONTS,
        *[f'<link rel="stylesheet" href="/css/{c}.css">' for c in cfg["css"]],
        *(['<link rel="stylesheet" href="/walletkit.css">'] if cfg.get("wallet") else []),  # RainbowKit modal
    ])
    s = put(s, "head", head, r"$^")
    header = read(os.path.join(PART, "header.html")).replace("{{CTA}}", cfg["cta"])
    if cfg["nav"]:
        header = header.replace(f'data-nav="{cfg["nav"]}"', f'data-nav="{cfg["nav"]}" aria-current="page"')
    sprite = read(os.path.join(PART, "sprite.html")).strip()
    s = put(s, "header", sprite + "\n" + header.strip(), r'<svg width="0" height="0".*?(?=<main)')
    s = put(s, "footer", read(os.path.join(PART, "footer.html")).strip(), r"<footer.*?</footer>")
    s = re.sub(r'<body[^>]*>', f'<body class="{cfg["body"]}">', s, count=1)
    open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("built", rel)

if __name__ == "__main__":
    for rel, cfg in PAGES.items():
        build(rel, cfg)
