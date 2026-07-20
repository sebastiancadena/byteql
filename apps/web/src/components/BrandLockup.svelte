<script lang="ts">
  import brandLockupUrl from '../assets/byteql.svg';
</script>

<!-- Full ByteQL logo lockup (icon + wordmark), shown uncropped so it stays crisp at
     any size. -->
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
