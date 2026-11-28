# Frontend architecture

## Why this lives in `web/`

The repository root already owns a TypeScript/Express backend in `src/`. To avoid mixing two `src/` trees or changing backend TypeScript settings, the Next.js application is isolated in `web/` with its own `package.json`, `tsconfig.json`, and `src/`.

Root scripts delegate to it:

- `npm run dev:web`
- `npm run build:web`
- `npm run typecheck:web`
- `npm run lint:web`

The existing backend `dev` and `start` scripts are unchanged.

## Established structure

```text
web/
├── src/
│   ├── app/
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── providers.tsx
│   ├── components/
│   │   └── ui/
│   ├── config/
│   │   └── env.ts
│   ├── features/
│   │   └── auth/
│   │       └── context/
│   │           └── auth-context.tsx
│   ├── lib/
│   │   ├── axios.ts
│   │   ├── query-client.ts
│   │   └── utils.ts
│   └── types/
│       └── auth.ts
├── .env.example
├── components.json
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── postcss.config.mjs
└── tsconfig.json
```

## Rules

- Route components live in `src/app`. Shared layouts and reusable UI live in `src/components`.
- Feature code lives in `src/features/<feature>`. Each feature may grow its own `components/`, `hooks/`, `api.ts`, and `schemas.ts` when that feature is implemented.
- API calls must not be written inside route components or presentational components. Put them in `src/features/<feature>/api.ts` and call them through hooks in `src/features/<feature>/hooks/`.
- Axios configuration is centralized in `src/lib/axios.ts`. It uses `NEXT_PUBLIC_API_URL` from `src/config/env.ts`; no localhost URL is hardcoded in application code.
- TanStack Query is configured once in `src/app/providers.tsx`; feature hooks should use that provider.
- React Hook Form schemas and resolver wiring belong in each feature's `schemas.ts` when forms are implemented.
- shadcn/ui components are generated into `src/components/ui`. `cn()` lives in `src/lib/utils.ts`.

## Deferred by design

These folders are intentionally not created yet because no files are needed at this stage:

- `src/app/(auth)/login`, `src/app/(auth)/register`
- `src/app/(dashboard)/dashboard`, `wallet`, `transactions`, `payments`
- `src/app/payment/result`
- `src/components/layout`, `src/components/shared`
- `src/features/wallet`, `payments`, `transactions`
- `src/types/wallet.ts`, `payment.ts`, `transaction.ts`

They are documented here so the intended shape is explicit without adding empty placeholders.

## Backend auth contract observed

The backend returns the JWT as a top-level `token` field in the login response body and returns the user under `userModel` (not `user`). Protected routes expect `Authorization: Bearer <token>`. There is no cookie usage, refresh flow, or server-side logout endpoint in the current backend.

This frontend foundation therefore:

- does not assume cookies or `localStorage`;
- keeps auth state in memory only for now;
- does not call login/register or persist tokens;
- provides `setSession()` so a future auth flow can attach the bearer token to the Axios instance without scattering auth logic through components.
