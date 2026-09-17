import { z } from 'zod';
export const bookmarkSchema = z.object({
  id: z.string().max(100),
  name: z.string().trim().min(1).max(100),
  engine: z.enum(['postgres', 'mysql', 'sqlite']),
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
