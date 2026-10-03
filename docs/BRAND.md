# Kursor brand guide

Kursor's identity is built from two things every developer recognises: a **text cursor** and a **code bracket**.
Together they form a K. The cursor is the only coloured element; everything else is quiet.

Source files live in [`brand/`](../brand). Rasterised icons are generated from them into `product/icons/`,
`media/` (extension), `site/img/` (website) and, at install time, into the app's `.icns` / `.ico`.

## Mark

| File | Use |
|---|---|
| `brand/kursor-mark.svg` | The app icon: mark on a dark rounded tile (58/256 corner radius). Launchers, dock, website favicon, social avatars. |
| `brand/kursor-glyph.svg` | Mark without the tile; the bracket uses `currentColor`. For dark or themed surfaces inside the app (chat empty state, About). |
| `brand/kursor-mark-mono.svg` | 24 px single-colour outline (`currentColor`, 2.4 stroke). Activity bar, status bar, menus, anywhere an icon must follow the UI colour. |
| `brand/kursor-wordmark.svg` | Mark + "Kursor" set in Inter 700, tracking −0.03 em. Website header, README, documents. |
| `brand/letterpress-*.svg` | Empty-editor watermark variants (dark / light / high-contrast). Installed over VS Code's letterpress. |
| `brand/social-card.svg` | 1200 × 630 Open Graph / social preview. |

Geometry (256 grid): cursor bar `x 78–102, y 62–194, r 10`; bracket stroke 24, round caps and joins,
vertex at `(110, 128)`, arms to `(176, 70)` and `(176, 186)`. Minimum size 16 px (mono) / 24 px (tile).
Clear space around the mark: ¼ of its width. Never recolour the bracket on the tile, never add a drop shadow,
never set the mark on the violet gradient.

## Colour

| Token | Hex | Role |
|---|---|---|
| Ink | `#0F1014` | Page and app background |
| Surface | `#1A1D25` | Cards, tiles, inputs |
| Border | `#262A35` | Hairlines |
| Mist | `#EEF0F6` | Primary text, the bracket |
| Muted | `#8B91A1` | Secondary text |
| Violet | `#7C8CFF` | Primary accent: focus, links, buttons, the cursor bar (top) |
| Orchid | `#B57CFF` | Accent gradient end, editor cursor, the cursor bar (bottom) |
| Keep | `#5FD38A` | Accepted / added |
| Undo | `#FF6B78` | Rejected / removed |
| Warn | `#E8A33D` | Needs approval |

Accent gradient: `linear-gradient(135deg, #7C8CFF, #B57CFF)`. Use it for the hero headline highlight, the
primary call-to-action and the cursor bar only. Interactive accent on dark surfaces: `#7C8CFF`, hover `#8F9BFF`,
text on accent `#0F1014`.

## In the app

**Kursor Dark** (`media/themes/kursor-dark.json`) is generated from the tokens above by
`scripts/build-theme.mjs` (`npm run theme`; CI fails when the committed file is stale). Every colour in it is a
token, a lightness step of one, or one of them with alpha:

- Ink is the window: title bar, status bar and the gaps between panels. Surface is the editor, side bars and panel,
  shown as floating cards with Border hairlines. Fields (inputs, dropdowns, code wells) are inset in Ink; menus,
  widgets and the command palette float one step above Surface (`#222631`).
- Text is `#CDD1DC`, headings and selected items Mist, secondary text Muted, line numbers `#5F6578`.
- Violet marks focus, links, buttons, badges, selections and the activity indicator. Orchid is the editor and
  terminal cursor. Keep / Undo / Warn are diffs and git status (added / removed / modified), errors and warnings.
- Syntax uses the accents lightened for text, plus one sky hue for types: keywords `#C99BFF`, functions `#8F9BFF`,
  strings `#8BDFA9`, numbers and constants `#EEBA6D`, types `#79CFEC`, tags `#FF8F9A`, comments `#6E768A` italic.
  Variables, properties and parameters stay in the text colour, operators and punctuation in Muted.

The Kursor extension sets the workbench defaults that carry the look (`contributes.configurationDefaults` in
`package.json`): VS Code's Modern UI (floating, rounded panels), the brand UI font stack (Inter, then Adwaita Sans,
which is Inter-based, then the system sans), the smooth-blinking cursor and no minimap. The installer seeds the
folded menu bar (`window.menuBarVisibility: compact`), which an extension cannot set.

## Type

- UI and website: **Inter** (fallback: system sans). Headlines 700 with −0.02 em tracking, body 400/500.
- Code: the user's editor font (JetBrains Mono by default on Omarchy).
- The product name is **Kursor** (capital K, never KURSOR or kursor in prose; the CLI command is `kursor`).

## Voice

Short, concrete, developer-to-developer. Say what a feature does and which key triggers it. No exclamation
marks, no "magic", no sparkle emoji. Always state plainly that Kursor runs the user's own Claude Code and is
not affiliated with Anthropic or Anysphere.

## Regenerating assets

```bash
for s in 16 24 32 48 64 128 256 512 1024; do rsvg-convert -w $s -h $s brand/kursor-mark.svg -o product/icons/kursor-$s.png; done
cp product/icons/kursor-1024.png product/icons/kursor.png
cp brand/kursor-mark.svg media/kursor.svg site/img/kursor.svg
cp brand/kursor-mark-mono.svg media/kursor-activity.svg
cp product/icons/kursor-32.png site/img/favicon.png && cp product/icons/kursor-512.png site/img/apple-touch-icon.png
rsvg-convert -w 1200 -h 630 brand/social-card.svg -o site/img/social-card.png
npm run theme   # media/themes/kursor-dark.json from scripts/build-theme.mjs
```

The installer builds `.icns` and `.ico` from `product/icons/*.png` on the fly.
