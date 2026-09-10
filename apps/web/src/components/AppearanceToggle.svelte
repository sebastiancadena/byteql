<script lang="ts">
  import type { Theme } from '../lib/ui/theme.js';
  import Icon from './ui/Icon.svelte';

  interface Props {
    theme: Theme;
    onchange: (theme: Theme) => void;
  }

  let { theme, onchange }: Props = $props();

  // The parent owns the reactive appearance; this control only reports the requested change.
  const next = $derived<Theme>(theme === 'light' ? 'dark' : 'light');
</script>

<button
  class="icon-button"
  type="button"
  aria-label={next === 'dark' ? 'Use dark appearance' : 'Use light appearance'}
  onclick={() => onchange(next)}
>
  <Icon name={next === 'dark' ? 'moon' : 'sun'} />
</button>
