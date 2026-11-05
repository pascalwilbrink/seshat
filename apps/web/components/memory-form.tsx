'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { MEMORY_TYPES, type CreateMemoryResultDto, type MemoryDto, type MemoryType } from '@/lib/api-types';
import { readFormError } from '@/lib/form-errors';
import {
  EMPTY_FORM,
  type FormErrors,
  MEMORY_LIMITS,
  type MemoryFormValues,
  buildCreateBody,
  buildUpdateBody,
  formFromMemory,
  validateForm,
} from '@/lib/memory-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from './form-field';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

export type MemoryFormMode =
  | { kind: 'create'; supersedes: string | null }
  | { kind: 'edit'; memory: MemoryDto };

export type MemoryFormResult =
  | { kind: 'created'; result: CreateMemoryResultDto }
  | { kind: 'updated'; memory: MemoryDto }
  /** The Memory was superseded (409) while editing; the caller should reload it to show the successor link. */
  | { kind: 'conflict' };

/**
 * Create / edit form in a side sheet. Sends only editable fields: never provenance, scope, status or embedding data.
 * Edit is a full-replacement PUT that carries the existing metadata over unchanged. Form values are never logged.
 */
export function MemoryForm({
  base,
  mode,
  onDone,
  onClose,
}: {
  /** The scope's memories URL (`/api/global/memories` or `/api/workspaces/<id>/memories`). */
  base: string;
  mode: MemoryFormMode;
  onDone: (r: MemoryFormResult) => void;
  onClose: () => void;
}) {
  const editing = mode.kind === 'edit';
  const [values, setValues] = useState<MemoryFormValues>(() => (mode.kind === 'edit' ? formFromMemory(mode.memory) : EMPTY_FORM));
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = <K extends keyof MemoryFormValues>(k: K, v: MemoryFormValues[K]) => setValues((s) => ({ ...s, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const found = validateForm(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    inFlight.current = true;
    setPending(true);
    try {
      const res =
        mode.kind === 'edit'
          ? await apiFetch(`${base}/${encodeURIComponent(mode.memory.id)}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildUpdateBody(values, mode.memory)),
            })
          : await apiFetch(base, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildCreateBody(values, mode.supersedes)),
            });
      if (!mounted.current) return;
      if (res.ok) {
        const body: unknown = await res.json();
        if (!mounted.current) return;
        onDone(mode.kind === 'edit' ? { kind: 'updated', memory: body as MemoryDto } : { kind: 'created', result: body as CreateMemoryResultDto });
        return;
      }
      if (res.status === 401) return setFormError(SESSION);
      const err = await readFormError(res);
      if (!mounted.current) return;
      if (res.status === 409 && mode.kind === 'edit') return onDone({ kind: 'conflict' });
      setErrors(
        Object.fromEntries(Object.entries(err.fields).filter(([k]) => ['type', 'title', 'content', 'tags', 'confidence', 'source'].includes(k))) as FormErrors,
      );
      setFormError(err.message);
    } catch {
      if (mounted.current) setFormError(NETWORK);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <SheetContent side="right" className="w-full max-w-lg overflow-y-auto sm:w-[32rem]">
        <SheetHeader>
          <SheetTitle>{editing ? 'Edit Memory' : mode.supersedes ? 'New replacement Memory' : 'New Memory'}</SheetTitle>
          <SheetDescription>
            {editing
              ? 'Saving replaces all fields shown here. Existing metadata is kept as it is.'
              : mode.supersedes
                ? 'Saving creates a new Memory and marks the original as superseded by it.'
                : 'Saving creates a Memory. Similar Memories are offered afterwards; nothing is merged automatically.'}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} noValidate aria-label={editing ? 'Edit Memory' : 'New Memory'} className="flex flex-col gap-4">
          <FormField id="memory-type" label="Type" error={errors.type}>
            {(p) => (
              <Select {...p} value={values.type} disabled={pending} onChange={(e) => set('type', e.target.value as MemoryType)}>
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField id="memory-title" label="Title (optional)" error={errors.title}>
            {(p) => <Input {...p} value={values.title} disabled={pending} onChange={(e) => set('title', e.target.value)} />}
          </FormField>
          <FormField id="memory-content" label="Content" error={errors.content} hint={`Up to ${MEMORY_LIMITS.content} characters.`}>
            {(p) => <Textarea {...p} required rows={6} value={values.content} disabled={pending} onChange={(e) => set('content', e.target.value)} />}
          </FormField>
          <FormField id="memory-tags" label="Tags (optional)" error={errors.tags} hint="Comma separated. Tags are shared with Files in this scope.">
            {(p) => <Input {...p} value={values.tags} disabled={pending} onChange={(e) => set('tags', e.target.value)} />}
          </FormField>
          <FormField id="memory-confidence" label="Confidence (optional)" error={errors.confidence} hint="A number from 0 to 1. Leave empty for none.">
            {(p) => <Input {...p} type="text" inputMode="decimal" value={values.confidence} disabled={pending} onChange={(e) => set('confidence', e.target.value)} />}
          </FormField>
          <FormField id="memory-source" label="Source (optional)" error={errors.source}>
            {(p) => <Input {...p} value={values.source} disabled={pending} onChange={(e) => set('source', e.target.value)} />}
          </FormField>
          {formError && (
            <p role="alert" className="break-words text-sm text-destructive">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create Memory'}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
