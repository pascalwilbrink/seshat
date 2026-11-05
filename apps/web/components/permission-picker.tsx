'use client';

import { GLOBAL_READ_PERMISSION, PERMISSION_AREAS, type Permission } from '@seshat/domain';
import { KEY_PRESETS } from '@/lib/api-key-presets';
import { Button } from '@/components/ui/button';

function actionLabel(permission: Permission): string {
  const action = permission.includes(':') ? permission.split(':')[1]! : permission;
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/**
 * Grouped permission checkboxes from the shared catalog, presets, and a separate Global toggle.
 * Presets replace only the operational permissions; they never touch the Global grant.
 */
export function PermissionPicker({
  idPrefix,
  value,
  onChange,
  disabled,
  error,
}: {
  idPrefix: string;
  value: readonly Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const has = (p: Permission) => value.includes(p);
  const toggle = (p: Permission) => onChange(has(p) ? value.filter((v) => v !== p) : [...value, p]);
  const globalOn = has(GLOBAL_READ_PERMISSION);
  const errorId = error ? `${idPrefix}-permissions-error` : undefined;

  return (
    <div>
      <div role="group" aria-label="Presets" className="my-2 flex flex-wrap gap-2">
        {KEY_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant="secondary" size="sm"
            disabled={disabled}
            onClick={() => onChange([...preset.permissions, ...(globalOn ? [GLOBAL_READ_PERMISSION] : [])])}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div role="group" aria-label="Permissions" aria-describedby={errorId}>
        {PERMISSION_AREAS.filter((a) => a.id !== 'global').map((area) => (
          <fieldset key={area.id} className="my-2 min-w-0 rounded-md border border-border px-3 py-2">
            <legend>{area.label}</legend>
            {area.permissions.map((p) => (
              <label key={p} className="flex items-center gap-2 py-0.5">
                <input type="checkbox" className="size-4 accent-primary" checked={has(p)} disabled={disabled} onChange={() => toggle(p)} />
                <span>
                  {actionLabel(p)} <code>{p}</code>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <fieldset className="my-2 min-w-0 rounded-md border border-primary px-3 py-2">
        <legend>Global knowledge</legend>
        <label className="flex items-center gap-2 py-0.5">
          <input
            type="checkbox" className="size-4 accent-primary"
            checked={globalOn}
            disabled={disabled}
            aria-describedby={`${idPrefix}-global-help`}
            onChange={() => toggle(GLOBAL_READ_PERMISSION)}
          />
          <span>
            Allow reading Global <code>{GLOBAL_READ_PERMISSION}</code>
          </span>
        </label>
        <p id={`${idPrefix}-global-help`} className="m-0 text-sm text-muted-foreground">
          Read-only. Global is only readable when this is on and the key also has the matching read permission (for
          example files:read). It never allows writing, deleting or managing anything in Global.
        </p>
      </fieldset>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive break-words">
          {error}
        </p>
      )}
    </div>
  );
}
