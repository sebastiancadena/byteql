<script lang="ts">
  // Test-only harness: snippets cannot be passed through Testing Library's props, so this
  // supplies two identifiable panels and forwards every other prop unchanged.
  import type { Bounds } from '../lib/ui/panel-layout.js';
  import type { TraceSummary } from '../lib/ui/trace.js';
  import TraceDock from './TraceDock.svelte';

  interface Props {
    summary: TraceSummary;
    collapsed: boolean;
    oncollapsedchange: (collapsed: boolean) => void;
    compact: boolean;
    showValues: boolean;
    tab: 'values' | 'bytes';
    ontabchange: (tab: 'values' | 'bytes') => void;
    onreveal: () => void;
    height?: number;
    valuesWidth?: number;
    valuesBounds?: Bounds;
    cancelEpoch?: number;
    onvaluestart?: () => void;
    onvaluespreview?: (value: number) => void;
    onvaluescommit?: (value: number) => void;
    onvaluescancel?: () => void;
    onvaluesreset?: () => void;
    onchromechange?: (value: { strip: number; tabs: number }) => void;
  }

  let {
    height = 248,
    valuesWidth = 256,
    valuesBounds = { min: 200, max: 480 },
    cancelEpoch = 0,
    onvaluestart = () => undefined,
    onvaluespreview = () => undefined,
    onvaluescommit = () => undefined,
    onvaluescancel = () => undefined,
    onvaluesreset = () => undefined,
    onchromechange = () => undefined,
    ...rest
  }: Props = $props();
</script>

{#snippet values()}
  <p data-testid="values-panel">values</p>
{/snippet}

{#snippet bytes()}
  <p data-testid="bytes-panel">bytes</p>
{/snippet}

<TraceDock
  {...rest}
  {height}
  {valuesWidth}
  {valuesBounds}
  {cancelEpoch}
  {onvaluestart}
  {onvaluespreview}
  {onvaluescommit}
  {onvaluescancel}
  {onvaluesreset}
  {onchromechange}
  {values}
  {bytes}
/>
