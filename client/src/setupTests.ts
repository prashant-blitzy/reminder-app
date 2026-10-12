/**
 * Vitest setup file for the client workspace.
 *
 * `client/vite.config.ts` names this module in `test.setupFiles`
 * (`'./src/setupTests.ts'`), so vitest loads it once before every suite in this
 * workspace. Its entire job is to register Testing Library's DOM matchers into
 * vitest's own assertion object, so that a component assertion about an element
 * being in the document both type-checks under this workspace's TypeScript
 * configuration and runs. The path and the file name are a contract with that
 * configuration: renaming or moving this module stops every client suite from
 * booting, before any test body executes.
 *
 * It registers matchers and nothing else, deliberately. Everything each suite
 * substitutes for itself stays with that suite: notification fakes, clock and
 * timer control, and HTTP fakes are installed per test file and restored there.
 * jsdom implements no notification API, which is the state the unsupported
 * browser case is tested against; a shared fake installed once here would make
 * both that case and the faked-clock case unreachable for every suite while the
 * suite still appeared to pass.
 */
// Registers Testing Library's DOM matchers with vitest's own `expect`.
// The `/vitest` entry point is the correct one here: it augments vitest's
// `Assertion` interface, whereas the bare `@testing-library/jest-dom` entry
// augments jest's globals, which this workspace does not use.
import '@testing-library/jest-dom/vitest';
