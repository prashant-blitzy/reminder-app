/*
 * Ambient type declarations for the client workspace.
 *
 * One declaration only, and it is the reason this file exists: `client/src/main.tsx` loads the
 * screen's stylesheet with a side-effect import — `import './styles.css'` — which is the sole route
 * that stylesheet reaches the document, because `client/index.html` carries no `<link>` of its own.
 * TypeScript rejects that import under the workspace's strict settings unless the extension is
 * declared somewhere in the program (`TS2882: Cannot find module or type declarations for side-effect
 * import of './styles.css'`), and Vite's own client declarations are what declare it:
 * `declare module '*.css' {}` and its siblings for the other asset extensions.
 *
 * The reference is written here rather than as a `types` entry in `client/tsconfig.json` so that the
 * declarations load with the source they describe, and it survives that file's `types` list staying
 * scoped to the test globals. Vite itself has always handled this import — it bundles the stylesheet,
 * fingerprints it and injects the link into the built page — so nothing about the build depends on
 * this file; it is what makes the same source type-check.
 */
/// <reference types="vite/client" />
