<!-- Starting point for NestJS repos. Keep only what you confirmed in the code. -->

## Conventions
- One NestJS module per domain; each domain has `*.entity.ts`, `*.dto.ts`, `*.mapper.ts`, `*.service.ts`, `*.controller.ts`, `*.module.ts`.
- ESM (`"type": "module"`): relative imports end in `.js`.
- DTOs are zod schemas; types via `z.infer`. Validate with a `ZodValidationPipe`.
- Import zod-inferred types with `import type`; import injected classes normally (DI needs the runtime reference).
- Services return DTOs via a mapper, never entities, except methods documented as internal.
- Controllers only validate and delegate; business logic lives in services.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`, …); never let ORM errors leak to clients.
- Validate route ids with `ParseUUIDPipe` when ids are UUIDs.
- Entities follow the `typeorm-snake-case-columns` skill.
- Unit tests next to the code as `*.spec.ts`; e2e tests in `test/`.
