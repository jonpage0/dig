// Development-only TypeScript loading for build scripts and provider checks.
// module.registerHooks (Node 22.15 and 23.5 onward) runs the hooks in this thread; an older Node 22 falls back to
// module.register, which Node now deprecates, so the development floor stays where the runtime's is.
import * as module from 'node:module';
import { resolveSync, loadSync } from './typescript-hooks.mjs';

if (module.registerHooks) module.registerHooks({ resolve: resolveSync, load: loadSync });
else module.register('./typescript-hooks.mjs', import.meta.url);
