// Dig's package version, shared by the service, the views, the host wrappers and the build, which refuses a
// package.json or package-lock.json that differs. The service puts it in each view's URI, so a host loads a new
// version's view rather than a cached one; the library view also compares its own copy with the service's, in case a
// host still shows an older view. `dig mcp` replaces a running service of another version.
export const VERSION = '1.2.2';
// The User-Agent of every provider request Dig sends that sets one.
export const USER_AGENT = `dig/${VERSION}`;
