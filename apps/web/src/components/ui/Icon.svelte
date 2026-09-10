<script lang="ts">
  // A finite, hand-drawn vocabulary. No icon package: every glyph is a stroke-only path on the
  // same 24-unit grid, so they share weight and optical size with each other and with the type.
  const paths = {
    sources: 'M3 4h18v16H3z M9 4v16',
    values: 'M3 4h18v16H3z M15 4v16',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    moon: 'M20 15a8 8 0 0 1-11-11A8 8 0 1 0 20 15z',
    shortcuts: 'M3 6h18v12H3z M6 9h1 M10 9h1 M14 9h1 M18 9h1 M6 12h1 M10 12h1 M14 12h1 M18 12h1 M7 15h10',
    chevron: 'm8 4 8 8-8 8',
    close: 'm6 6 12 12 M18 6 6 18',
    file: 'M5 3h9l5 5v13H5z M14 3v6h5',
    table: 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v16',
    arrow: 'M4 12h16 M14 6l6 6-6 6',
  } as const;

  // Icons are decorative; the parent control supplies the accessible name.
  let { name }: { name: keyof typeof paths } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  width="16"
  height="16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={paths[name]} />
</svg>
