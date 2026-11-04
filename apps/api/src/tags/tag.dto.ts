import { z } from 'zod';
import { TAG_NAME_MAX_LENGTH, TAG_NAME_PATTERN } from './tag.entity.js';
import { normalizeTagName } from './tag-name.js';

/** Trims and lowercases, then validates length and characters. */
export const tagNameSchema = z
  .string({ error: 'Name must be a string' })
  .transform(normalizeTagName)
  .pipe(
    z
      .string()
      .min(1, 'Name must not be empty')
      .max(TAG_NAME_MAX_LENGTH, `Name must be at most ${TAG_NAME_MAX_LENGTH} characters`)
      .regex(TAG_NAME_PATTERN, 'Name may only contain letters, digits, "-", "_", ".", ":" and "/"'),
  );

/** Tags are flat: the only updatable field is the name. */
export const renameTagSchema = z.strictObject({ name: tagNameSchema });
export type RenameTagInput = z.infer<typeof renameTagSchema>;

export interface TagDto {
  id: string;
  name: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  /** Files carrying this Tag, within the Tag's own scope. */
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}
