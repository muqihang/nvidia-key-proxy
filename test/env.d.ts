import type { WorkerEnv } from '../src/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends WorkerEnv {}
}
