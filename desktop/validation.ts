import { z } from 'zod';
import { SQL_TEXT_LIMIT } from '../src/shared';
export const bookmarkSchema = z
  .object({
    id: z.string().max(100),
    name: z.string().trim().min(1).max(100),
    engine: z.enum(['postgres', 'mysql', 'sqlite']),
    input: z.enum(['database', 'sql']).optional(),
    sqlSource: z.enum(['file', 'text']).optional(),
    sqlText: z
      .string()
      .max(SQL_TEXT_LIMIT, 'Pasted SQL is too large. Choose a SQL file for larger dumps.')
      .optional(),
    sqlContent: z.enum(['schema', 'data']).optional(),
    sqlVersion: z.enum(['15', '16', '17', '18', '8.0', '8.4']).optional(),
    host: z.string().max(1000).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().max(1000).optional(),
    password: z.string().max(10000).optional(),
    database: z.string().max(1000).optional(),
    url: z.string().max(10000).optional(),
    file: z.string().max(4096).optional(),
    ssl: z
      .object({
        enabled: z.boolean(),
        ca: z.string().optional(),
        cert: z.string().optional(),
        key: z.string().optional(),
      })
      .optional(),
    ssh: z
      .object({
        enabled: z.boolean(),
        host: z.string().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        privateKey: z.string().optional(),
        passphrase: z.string().optional(),
        fingerprint: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((b, ctx) => {
    if (b.input !== 'sql') return;
    if (b.sqlSource === 'text') {
      if (!b.sqlText?.trim())
        ctx.addIssue({ code: 'custom', path: ['sqlText'], message: 'Paste SQL text.' });
    } else if (!b.file)
      ctx.addIssue({ code: 'custom', path: ['file'], message: 'Choose a SQL file.' });
    if (!b.sqlContent)
      ctx.addIssue({
        code: 'custom',
        path: ['sqlContent'],
        message: 'Select the SQL contents.',
      });
    const versions =
      b.engine === 'postgres'
        ? ['15', '16', '17', '18']
        : b.engine === 'mysql'
          ? ['8.0', '8.4']
          : [];
    if (b.sqlVersion && !versions.includes(b.sqlVersion))
      ctx.addIssue({
        code: 'custom',
        path: ['sqlVersion'],
        message: 'Import version must match the selected engine.',
      });
  });
export const endpointSchema = z.object({
  bookmarkId: z.string(),
  database: z.string().min(1).max(4096),
});
export const requestSchema = z.object({
  left: endpointSchema,
  right: endpointSchema,
  tables: z
    .array(z.string().max(4096))
    .min(1)
    .max(10000)
    .transform((a) => [...new Set(a)]),
  keys: z.record(
    z.string(),
    z
      .array(z.string().max(1000))
      .max(100)
      .refine((a) => new Set(a).size === a.length),
  ),
  schemaOnly: z.boolean(),
});
