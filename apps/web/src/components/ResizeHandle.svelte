<script lang="ts">
  import { resizeHandle, type ResizeOptions } from '../lib/ui/resize-handle.js';

  interface Props extends ResizeOptions {
    /** Accessible name for the separator, e.g. "Resize sources panel". */
    label: string;
    /** id of the panel this separator resizes, for `aria-controls`. */
    controls: string;
    /** Extra class for callers that need a size-class hook (e.g. a compact/drawer layout). */
    compatibilityClass?: string;
  }

  let {
    orientation,
    direction,
    value,
    min,
    max,
    disabled = false,
    cancelEpoch = 0,
    onstart,
    onpreview,
    oncommit,
    oncancel,
    onreset,
    label,
    controls,
    compatibilityClass,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class={`panel-resize ${compatibilityClass ?? ''}`}
  data-orientation={orientation}
  role="separator"
  aria-label={label}
  aria-orientation={orientation}
  aria-controls={controls}
  aria-valuemin={Math.round(min)}
  aria-valuemax={Math.round(max)}
  aria-valuenow={Math.round(value)}
  aria-valuetext={`${Math.round(value)} pixels ${orientation === 'horizontal' ? 'high' : 'wide'}`}
  aria-disabled={disabled || undefined}
  tabindex={disabled ? -1 : 0}
  use:resizeHandle={{
    orientation,
    direction,
    value,
    min,
    max,
    disabled,
    cancelEpoch,
    onstart,
    onpreview,
    oncommit,
    oncancel,
    onreset,
  }}
></div>
