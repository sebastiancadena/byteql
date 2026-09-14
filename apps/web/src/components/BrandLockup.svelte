<script lang="ts">
  import brandLockupUrl from '../assets/byteql.svg';
</script>

<!-- Selected ByteQL card (symbol + wordmark), with a vector border and the
     original raster artwork. Only the unused outer canvas has been trimmed. -->
<span class="brand-lockup" data-brand-lockup>
  <img src={brandLockupUrl} alt="ByteQL" />
</span>

<style>
  .brand-lockup {
    display: inline-block;
    width: var(--brand-lockup-size, clamp(4.75rem, 9vw, 7rem));
    line-height: 0;
  }

  img {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
