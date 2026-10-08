// Dig's package version, shared by the server, the views and the build, which refuses a manifest that differs.
// The server puts it in each view's URI, so Codex loads a new version's view rather than a cached one; the library
// view also compares its own copy with the server's, in case Codex still shows an older view.
export const VERSION = '0.2.29';
