import { describe, expect, it } from "vitest";
import { app } from "../src/index";

/**
 * The route table, as Hono will match it: method, path pattern and the name
 * of each handler, in registration order.
 *
 * This is the guard for refactors that move routes between files. Order is
 * semantics in Hono - a middleware registered after a route does not run for
 * it - so a reshuffle that changes this list has changed behaviour, even if
 * every endpoint still exists.
 */
const table = () => app.routes.map((r) => `${r.method} ${r.path} ${r.handler.name}`);

describe("route table", () => {
  it("is unchanged", () => {
    expect(table()).toMatchSnapshot();
  });
});
