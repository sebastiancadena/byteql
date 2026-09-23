import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'must be an identifier');
const magic = z.strictObject({
  at: z.number().int().nonnegative(),
  hex: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/u, 'must be an even-length hex string'),
  confidence: z.number().gt(0).lte(1),
});
const container = z.strictObject({
  id: identifier,
  framer: identifier,
  probe: z.union([z.strictObject({ magic: z.array(magic).min(1) }), z.strictObject({ hook: identifier })]),
});

export const packManifestSchema = z
  .strictObject({
    version: z.literal('0.1'),
    id: identifier,
    title: z.string().min(1),
    spec: z.string().min(1),
    queries: z.string().min(1),
    capabilities: z.array(identifier).default([]),
    errors: z.strictObject({ ordinal: identifier }).default({ ordinal: 'record' }),
    ksy: z.strictObject({ dir: z.string().min(1), roots: z.array(identifier).min(1).optional() }).optional(),
    containers: z.array(container).min(1),
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    manifest.containers.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          path: ['containers', index, 'id'],
          message: 'duplicate container id',
        });
      }
      seen.add(entry.id);
    });
  });

export type PackManifest = z.output<typeof packManifestSchema>;

export class PackManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'PackManifestError';
  }
}

export const parsePackManifest = (value: unknown, file = 'pack.yaml'): PackManifest => {
  const parsed = packManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.length === 0 ? '$' : issue.path.map(String).join('.');
  throw new PackManifestError(path, `${file}: ${path}: ${issue.message}`);
};
