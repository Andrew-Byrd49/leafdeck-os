# A Leafdeck Designer design

This folder is one design from Leafdeck Designer: a few UI elements (a button, a menu, an input field…), each drawn as a
top-level frame. Leafdeck rewrites this file; don't edit it.

## Files

- `design.json`: the design. Designer saves it as the user works and reloads it when you finish a turn, so you can edit it.
- `assets/<id>.<ext>`: images and fonts, referenced from design.json as `asset:<id>`.
- `handoff/`: written by Designer before each message you get, for the component the user has selected:
  - `handoff/spec.md`: what to build: the spec, the layers, the reference HTML and CSS, the user's notes. **Start here.**
  - `handoff/component.html`: the component alone, as a page (open it to see it), with `handoff/styles.css`.
  - `handoff/preview.png`: a picture of the design. `handoff/original.png`: the element it was captured from, if any.
  - `handoff/markup.png`: the design with the user's markup on it, when they drew on it (see "Markup" below).
- `build/`: yours. What you build goes here: the component's source (e.g. `build/Button.jsx`, `build/button.css`) and
  `build/index.html`, a demo page showing it working in every state. Designer shows the demo live beside the design,
  served from this folder, so it can load the files next to it (`button.css`, `button.js`, `../assets/…`) by relative
  path, plus React, Vue, Tailwind, fonts etc. from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com, esm.sh or
  cdn.tailwindcss.com. No build step runs: the demo must work as plain files in the browser.
- `trace/`: when asked to recreate a screenshot as layers, write plain HTML with inline `<style>` to the file named in the
  request (no scripts). Designer renders it and turns it into editable layers.

## design.json

```json
{
  "id": "…", "name": "Sign-up button",
  "nodes": [ /* top-level frames: one per component, plus its states */ ],
  "meta": { "<frame id>": { "notes": "what it should do", "framework": "react", "source": { "url": "…", "title": "…", "html": "…" } } },
  "fonts": [ { "family": "Inter", "weight": "400", "style": "normal", "asset": "<asset id>" } ],
  "marks": [ /* the user's markup (below) */ ],
  "view": { "x": 0, "y": 0, "z": 1 }
}
```

A node (a layer):

```json
{
  "id": "unique", "type": "frame | rect | ellipse | text | image | svg", "name": "Label",
  "x": 0, "y": 0, "w": 120, "h": 40,          // px, relative to the parent's top-left (the canvas for top-level frames)
  "sizing": { "w": "fixed | hug | fill", "h": "fixed | hug | fill" },  // hug = fit content; fill = take the room in the parent's auto layout
  "tag": "button",                              // the HTML element to build it as (frames; default div)
  "attrs": { "aria-label": "…", "type": "submit" },
  "hidden": false, "locked": false, "absolute": false,   // absolute: ignores the parent's auto layout, placed at x/y
  "layout": { "mode": "none | row | column", "gap": 8, "padding": [10, 16, 10, 16], "align": "start | center | end | stretch | baseline",
              "justify": "start | center | end | between", "wrap": false },   // frames: auto layout is CSS flexbox
  "clip": true,                                  // overflow hidden
  "fills": [ { "type": "solid", "color": "#0a84ff" },                       // first = on top (CSS background order)
             { "type": "linear", "angle": 180, "stops": [ { "color": "#fff", "pos": 0 }, { "color": "#000", "pos": 1 } ] },
             { "type": "image", "src": "asset:<id>", "fit": "cover" }, { "type": "css", "value": "radial-gradient(…)" } ],
  "stroke": { "color": "#d0d0d0", "width": 1, "style": "solid", "align": "inside | outside | center", "sides": [1, 0, 1, 0] },
  "radius": 8,                                   // or [topLeft, topRight, bottomRight, bottomLeft]
  "effects": [ { "type": "drop | inner", "x": 0, "y": 2, "blur": 6, "spread": 0, "color": "rgba(0, 0, 0, 0.2)" },
               { "type": "blur | bg-blur", "radius": 12 } ],
  "opacity": 1,
  "text": "Sign up",                             // text layers
  "font": { "family": "Inter, sans-serif", "size": 14, "weight": 600, "lineHeight": "auto", "letterSpacing": 0,
            "align": "left | center | right", "color": "#ffffff", "italic": false, "transform": "uppercase", "decoration": "underline" },
  "src": "asset:<id>", "fit": "cover",           // images
  "markup": "<svg …>", "color": "#000",          // svg (currentColor = color)
  "icon": { "set": "lucide | tabler | tabler-filled", "name": "house", "stroke": 2 },  // an svg from the icon library
  "css": { "cursor": "pointer" },                // extra CSS the inspector has no control for
  "children": [ /* frames only */ ]
}
```

A **state** of a component is another top-level frame with `"variant": { "of": "<base frame id>", "state": "hover" }`
(states: hover, pressed, focus, disabled, selected, open, error, or any name). Its layers carry `"link": "<id of the
matching layer in the base>"`; the generated CSS is the base plus the differences under `:hover`, `:active`,
`:focus-visible`, `:disabled`…

## Markup

The user can draw over the canvas to show you what they mean: freehand strokes, lines, arrows, boxes and notes. It's
not part of the design (it never becomes HTML); read it as instructions. `handoff/markup.png` shows it over the design,
and `handoff/spec.md` lists it under "The user's markup" with each note's text. In design.json it's `marks`, in canvas
coordinates (the same as top-level frames' x / y):

```json
{ "id": "…", "kind": "pen | line | arrow | box | note", "pts": [[x, y], …], "color": "#f24822", "text": "for notes" }
```

A pen stroke has many points; a line, arrow (pointing at its second point) or box (two corners) has two; a note has one
(its top-left). Leave marks alone unless the user asks you to clear them.

## Icons

Icons from Designer's library are `svg` layers with `icon` set: Lucide (lucide.dev) or Tabler Icons (tabler.io/icons),
24×24 viewBox, drawn in currentColor. When building, use the same icon from that set's package for the framework
(`lucide-react`, `@tabler/icons-react`…) or inline the SVG.

When you edit design.json: keep ids unique (new ids: 8+ lowercase letters and digits), keep `link`s pointing at the base,
and keep the JSON valid. Prefer auto layout (`layout.mode` row/column with `sizing` hug/fill) over absolute positions.
