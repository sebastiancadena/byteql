<script lang="ts">
  import brandMarkUrl from '../assets/byteql.svg';

  interface Props {
    size?: 'small' | 'medium' | 'large';
  }

  let { size = 'small' }: Props = $props();
</script>

<span class="brand-mark" data-brand-mark data-size={size} aria-hidden="true">
  <img src={brandMarkUrl} alt="" />
</span>

<style>
  .brand-mark {
    display: inline-grid;
    position: relative;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
    overflow: hidden;
    place-items: center;
  }

  .brand-mark[data-size='medium'] {
    width: 3rem;
    height: 3rem;
  }

  .brand-mark[data-size='large'] {
    width: 4.5rem;
    height: 4.5rem;
  }

  img {
    display: block;
    position: absolute;
    top: 50%;
    left: 50%;
    width: 170%;
    max-width: none;
    transform: translate(-50%, -45.5%);
  }
</style>
