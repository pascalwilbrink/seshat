import type { OverviewDto, WorkspaceDto } from './workspace.dto.js';
import type { Workspace } from './workspace.entity.js';

export function toWorkspaceDto(w: Workspace): WorkspaceDto {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    description: w.description ?? null,
    createdAt: new Date(w.createdAt).toISOString(),
    updatedAt: new Date(w.updatedAt).toISOString(),
  };
}

export function toWorkspaceOverviewDto(w: Workspace): OverviewDto {
  return {
    scope: 'workspace',
    id: w.id,
    name: w.name,
    slug: w.slug,
    description: w.description ?? null,
    createdAt: new Date(w.createdAt).toISOString(),
  };
}

export const GLOBAL_OVERVIEW: OverviewDto = Object.freeze({ scope: 'global', name: 'Global' }) as OverviewDto;
