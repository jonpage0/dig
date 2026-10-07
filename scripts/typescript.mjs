// Development-only TypeScript loading for build scripts and provider checks.
import { register } from 'node:module';

register('./typescript-hooks.mjs', import.meta.url);
