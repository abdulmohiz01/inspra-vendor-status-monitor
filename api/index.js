// Vercel function serving the whole app; vercel.json rewrites every path here.
// Equivalent to `handle(app)` from hono/vercel, which is deprecated ahead of Hono v5.
//
// Plain JavaScript on purpose: @vercel/node compiles .ts entrypoints with the project's
// TypeScript, and TypeScript 7 has no JS compiler API, so that build crashes. Vercel runs
// `pnpm build` (tsc -> dist/) before building functions, and this file imports its output.
import { createLazyApp } from '../dist/vercel.js';

const app = createLazyApp();
/** @param {Request} req */
const handler = (req) => app.fetch(req);

export const GET = handler;
export const POST = handler;
export const HEAD = handler;
