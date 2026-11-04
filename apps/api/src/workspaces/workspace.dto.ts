import { z } from 'zod';
import { RESERVED_WORKSPACE_SLUG, WORKSPACE_SLUG_PATTERN } from './workspace.entity.js';

export const MAX_WORKSPACE_NAME_LENGTH = 100;
export const MAX_WORKSPACE_SLUG_LENGTH = 100;
export const MAX_WORKSPACE_DESCRIPTION_LENGTH = 2000;

const name = z
  .string({ error: 'Name must be a string' })
  .trim()
  .min(1, 'Name must not be empty')
  .max(MAX_WORKSPACE_NAME_LENGTH, `Name must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`);

const slug = z
  .string({ error: 'Slug must be a string' })
  .max(MAX_WORKSPACE_SLUG_LENGTH, `Slug must be at most ${MAX_WORKSPACE_SLUG_LENGTH} characters`)
  .regex(WORKSPACE_SLUG_PATTERN, 'Slug must be lowercase kebab-case (a-z, 0-9, single hyphens)')
  .refine((s) => s !== RESERVED_WORKSPACE_SLUG, { error: `Slug "${RESERVED_WORKSPACE_SLUG}" is reserved` });

/** Blank descriptions are stored as null. */
const description = z
  .string({ error: 'Description must be a string' })
  .trim()
  .max(MAX_WORKSPACE_DESCRIPTION_LENGTH, `Description must be at most ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters`)
  .nullable()
  .transform((d) => (d === '' ? null : d));

export const createWorkspaceSchema = z.strictObject({
  name,
  slug: slug.optional(),
  description: description.optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

/** Only name and description are updatable; the slug is fixed. */
export const updateWorkspaceSchema = z
  .strictObject({ name: name.optional(), description: description.optional() })
  .refine((v) => v.name !== undefined || v.description !== undefined, { error: 'Provide name and/or description' });
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const deleteWorkspaceSchema = z.strictObject({
  slug: z.string({ error: 'Slug confirmation must be a string' }).max(MAX_WORKSPACE_SLUG_LENGTH + 100, 'Slug confirmation is too long'),
});
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceSchema>;

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OverviewDto =
  | { scope: 'global'; name: string }
  | { scope: 'workspace'; id: string; name: string; slug: string; description: string | null; createdAt: string };
