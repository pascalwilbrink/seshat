import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_AREAS, getActionRequirement } from '@seshat/domain';

describe('shared permission catalog in the web app', () => {
  it('is importable and browser-safe', () => {
    expect(PERMISSIONS).toHaveLength(10);
    expect(PERMISSION_AREAS.flatMap((a) => [...a.permissions])).toHaveLength(10);
    expect(getActionRequirement('workspace:delete')).toEqual({ classification: 'admin' });
    expect(getActionRequirement('unknown')).toBeUndefined();
  });
});
