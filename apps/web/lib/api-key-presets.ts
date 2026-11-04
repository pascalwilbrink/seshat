import type { Permission } from '@seshat/domain';

export interface KeyPreset {
  id: string;
  label: string;
  /** Operational permissions only: never a delete grant and never `global:read`. */
  permissions: readonly Permission[];
}

const READ: readonly Permission[] = ['files:read', 'collections:read', 'memories:read', 'search'];

export const KEY_PRESETS: readonly KeyPreset[] = [
  { id: 'agent-read', label: 'Agent: read', permissions: READ },
  {
    id: 'agent-read-write',
    label: 'Agent: read and write',
    permissions: [...READ, 'files:write', 'collections:write', 'memories:write'],
  },
];
