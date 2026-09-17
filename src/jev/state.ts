/**
 * Shapes shared with the JEV layer.
 *
 * These are types only. The transport, question set, and decision mapping live in
 * this directory too, but they arrive in a later milestone.
 */

/** A JSON value accepted by the JEV `state` field. `Date` / `Map` are not included. */
export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson };

/**
 * The request state. `value` is the thing under judgment; `context` is the
 * session-scoped reference material (user policy, repository facts) that a
 * condition may point at explicitly, for example "`value.call` violates
 * `context.policy`".
 */
export interface JevState {
  readonly value: JevJson;
  readonly context: JevJson;
}
