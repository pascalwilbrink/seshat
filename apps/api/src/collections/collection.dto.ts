import { z } from 'zod';

export const MAX_COLLECTION_NAME_LENGTH = 100;
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 2000;

const name = z
  .string({ error: 'Name must be a string' })
  .trim()
  .min(1, 'Name must not be empty')
  .max(MAX_COLLECTION_NAME_LENGTH, `Name must be at most ${MAX_COLLECTION_NAME_LENGTH} characters`);

/** Blank descriptions are stored as null. */
const description = z
  .string({ error: 'Description must be a string' })
  .trim()
  .max(MAX_COLLECTION_DESCRIPTION_LENGTH, `Description must be at most ${MAX_COLLECTION_DESCRIPTION_LENGTH} characters`)
  .nullable()
  .transform((d) => (d === '' ? null : d));

export const createCollectionSchema = z.strictObject({ name, description: description.optional() });
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

/** `PUT` body: name and description (null clears it), both required; ownership (scope) never changes. */
export const updateCollectionSchema = z.strictObject({ name, description });
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export interface CollectionDto {
  id: string;
  name: string;
  description: string | null;
  /** Files of the same scope that belong to this Collection. */
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}
