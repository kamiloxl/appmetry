// Types for `env` from cloudflare:workers inside tests: the Worker's bindings plus the test-only migrations.
type AppdashEnv = import('../src/env').Env;

declare namespace Cloudflare {
  interface Env extends AppdashEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
