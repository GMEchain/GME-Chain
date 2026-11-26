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
| Headlines, big numbers, tilted tape (`--display`) | Dela Gothic One |
| Small uppercase labels: nav, kickers, tags, table heads (`--hud`) | DotGothic16, one weight, never bold |
| Body and UI (`--font`) | BIZ UDPGothic 400 and 700 |
| Code and addresses (`--mono`) | M PLUS 1 Code 400 and 600 |
| Logo wordmark (fixed), also the cartridge label and footer particles | "GME" Big Shoulders Display 900 + "chain" Instrument Serif italic |

Japanese arcade-cabinet type: a heavy gothic for the shouting, a dot-matrix face for the HUD that matches the ASCII particles. No stock "gaming" fonts.

## Pieces

- Buttons are game buttons: a solid face with a darker edge underneath that disappears when pressed.
- Windows have a 2px edge and round corners; the shop and the bridge ticket get a red frame.
- Signature visuals are ASCII "particle code": the 3D cartridge on the home page (`site/js/cartridge.js`) and the
  footer wordmark (`site/js/site.js`), both drawn from characters and reacting to the pointer.
- The tilted marquee tape ("PRESS START ▲ HOLD GME ▲ …") separates big moments.
- Motion: tape, blinking "PRESS START", hopping markers, the countdown, values that bump when they change.
  Everything stops under `prefers-reduced-motion`.
- No badges or pills. No diamonds.

## Files

- `site/css/base.css`: tokens, type, buttons, nav, footer.
- `site/css/home.css`, `site/css/app.css`, `site/css/docs.css`: page styles.
- `tools/partials/`: header, footer and icon sprite (`#i-*`). Run `python tools/build_pages.py` after editing them.
