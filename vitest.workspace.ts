import { defineWorkspace } from 'vitest/config';

/**
 * Running `vitest` from the repository root runs both projects. Each project
 * keeps its own configuration — the backend runs on Node with supertest, the
 * frontend on jsdom — so environment-sensitive tests behave the same whether
 * they are started from the root or from inside a workspace package.
 */
export default defineWorkspace(['backend', 'frontend']);
