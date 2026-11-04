export interface FormError {
  /** Safe, user-facing text for the whole form. */
  message: string;
  /** Field-level messages keyed by request field name. */
  fields: Record<string, string>;
  status: number;
}

const GENERIC = 'Something went wrong. Please try again.';

/** Turns an API error response into safe text: only 400/409 messages are shown; everything else is generic. */
export async function readFormError(res: Response): Promise<FormError> {
  const body: unknown = await res.json().catch(() => null);
  const obj = (body && typeof body === 'object' ? body : {}) as { message?: unknown; issues?: unknown };
  const apiMessage = typeof obj.message === 'string' ? obj.message : null;
  const fields: Record<string, string> = {};
  if (Array.isArray(obj.issues)) {
    for (const issue of obj.issues as { path?: unknown; message?: unknown }[]) {
      if (typeof issue?.path === 'string' && typeof issue.message === 'string' && issue.path && !(issue.path in fields)) {
        fields[issue.path] = issue.message;
      }
    }
  }
  if (res.status === 429) return { message: 'Too many requests. Wait a moment and try again.', fields, status: 429 };
  if (res.status === 400 || res.status === 409) {
    return { message: apiMessage && apiMessage !== 'Invalid request' ? apiMessage : 'Check the highlighted fields.', fields, status: res.status };
  }
  return { message: GENERIC, fields: {}, status: res.status };
}
