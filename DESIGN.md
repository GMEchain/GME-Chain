# GME CHAIN design system: "Player One"

GameStop sells games, and GME is the retail players' ticker. So the site is a game: a title screen with a
cartridge, a HUD of live numbers, an item shop for gas, achievements, a level map, a TV, a versus screen, cheat
codes, a warning screen, loading tips and a "Continue?" countdown. Colours are GME's: black and red.

## Colour

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#000000` | page |
| `--panel` / `--panel-2` | `#0F0F10` / `#18181A` | windows, inputs |
| `--edge` | `#2A2A2D` | 2px window edges, dashed separators |
| `--fg` / `--fg-2` / `--muted` | `#FFFFFF` / `#B8B8BC` / `#8C8C92` | text levels |
| `--up` | `#FF2D2D` | GME red: the brand and every action |
| `--up-deep` | `#8F0D12` | the pressed edge under red buttons, title shadows |
| `--warn` / `--down` | `#FFB020` | risk and warnings |
| `--ok` | `#3BE07E` | success only (confirmed transactions, copied) |

## Type

| Role | Font |
| --- | --- |
| Headlines, big numbers, tilted tape (`--display`) | Jersey 25 |
| Small uppercase labels: nav, kickers, tags, table heads (`--hud`) | Micro 5, one weight, never bold |
| Body and UI (`--font`) | Pixelify Sans 400 to 700, with digits and `$ %` from Jersey 25 (Pixelify's 5 reads as an S) |
| Code and addresses (`--mono`) | M PLUS 1 Code 400 and 600 |
| Logo wordmark (fixed), also the cartridge label and footer particles | "GME" Big Shoulders Display 900 + "chain" Instrument Serif italic |

Pixel type, like a jersey number on an arcade cabinet. All fonts are self-hosted from `site/fonts/` (SIL Open Font License) and declared in `site/css/fonts.css`, where `size-adjust` evens out their small x-heights. Ligatures are off: Pixelify joins "fi" into one glyph.

## Pieces

- Buttons are game buttons: a solid face with a darker edge underneath that disappears when pressed.
- Windows have a 2px edge and round corners; the shop and the bridge ticket get a red frame.
- Signature visuals are ASCII "particle code": the 3D cartridge on the home page (`site/js/cartridge.js`) and the
  footer wordmark (`site/js/site.js`), both drawn from characters and reacting to the pointer.
- The tilted marquee tape ("PRESS START ▲ HOLD GME ▲ …") separates big moments.
- Motion: tape, blinking "PRESS START", hopping markers, the countdown, values that bump when they change.
  Everything stops under `prefers-reduced-motion`.
- The explorer is the "game log": a scoreboard with zero-padded counters, a stage-select grid of the latest 48 blocks, and CRT screens (scanlines) for blocks as a high-score table and transactions as a move log. It polls every 5 seconds and flashes new rows in.
- No badges or pills. No diamonds.

## Files

- `site/css/base.css`: tokens, type, buttons, nav, footer.
- `site/css/home.css`, `site/css/app.css`, `site/css/docs.css`: page styles.
- `tools/partials/`: header, footer and icon sprite (`#i-*`). Run `python tools/build_pages.py` after editing them.
