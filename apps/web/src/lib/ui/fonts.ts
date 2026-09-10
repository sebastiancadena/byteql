import monoRegularUrl from '../../assets/fonts/IBMPlexMono-Regular.woff2?url';
import sansRegularUrl from '../../assets/fonts/IBMPlexSans-Regular.woff2?url';
import sansSemiboldUrl from '../../assets/fonts/IBMPlexSans-SemiBold.woff2?url';

type FontResult = 'loaded' | 'fallback';

let pending: Promise<FontResult> | null = null;

async function loadFonts(): Promise<FontResult> {
  let result: FontResult = 'fallback';
  try {
    if (typeof FontFace !== 'undefined' && document.fonts) {
      const definitions = [
        ['IBM Plex Sans', sansRegularUrl, '400'],
        ['IBM Plex Sans', sansSemiboldUrl, '600'],
        ['IBM Plex Mono', monoRegularUrl, '400'],
      ] as const;
      const faces = definitions.map(
        ([family, url, weight]) =>
          new FontFace(family, `url(${JSON.stringify(url)})`, { weight, style: 'normal' }),
      );
      // Settle every attempted load before deciding, so a failure leaves no request in flight.
      const outcomes = await Promise.allSettled(faces.map((face) => face.load()));
      if (outcomes.every((outcome) => outcome.status === 'fulfilled')) {
        for (const face of faces) document.fonts.add(face);
        result = 'loaded';
      }
    }
  } catch {
    // Fall back without blocking the query engine.
  }
  document.documentElement.dataset.fonts = result;
  return result;
}

/** Load the bundled Plex faces once per session; the settled result is reused by every caller. */
export function prepareUiFonts(): Promise<FontResult> {
  return (pending ??= loadFonts());
}
