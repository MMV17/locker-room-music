/**
 * The apex Worker has no bindings, and that is a feature.
 *
 * No D1, no secrets, no cron, no R2. It cannot read a school's data because it
 * has no handle to any, so the blast radius of a bug here stops at a static
 * page. Compare backend/src/types.ts, which needs five.
 *
 * `env` is still threaded through resolveTeam() so the teams map can become a
 * D1 lookup without a signature change at the call site. When that happens,
 * DB stops being optional and a [[d1_databases]] block appears in
 * wrangler.toml — and nothing else moves.
 */
export interface Env {
  /** Reserved for the cross-school teams registry. See resolveTeam(). */
  DB?: D1Database;
}
