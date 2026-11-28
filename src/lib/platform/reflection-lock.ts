/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Function` out of reach by reflection, in the server's process.
 *
 * App code runs in the platform's process, and the build's scan refuses
 * `Function`, `eval` and `process` by name (docs/security-architecture.md §24).
 * The cheapest way around it was reflection: every function's `.constructor`
 * is `Function`, so `(() => {}).constructor("return process")()` reached the
 * environment without naming either. The scan now refuses `.constructor` and
 * the prototype getters too, but a scan reads syntax, and a name built at
 * runtime (`x[a + b]`) gets past it.
 *
 * So when the server starts, `register()` (src/instrumentation.ts) points the
 * `constructor` of `Function.prototype`, and of the async, generator and async
 * generator function prototypes, at a function that refuses. Reached that way,
 * from any function, through any name, it throws. Each refusal keeps the name
 * of what it replaced, so a library that checks `fn.constructor.name`, as
 * regenerator does, still reads it.
 *
 * What it leaves alone: `Function` and `new Function(…)` by name, which the
 * platform's own dependencies use (Next's bundled `depd`, zod's check for
 * whether `eval` works) and which the scan refuses in app code.
 *
 * Why not Node's `--disallow-code-generation-from-strings`, which refuses
 * every route at once: `next start` fails to boot under it in Next 16. Its
 * bundled edge-runtime primitives call `new Function` as the server starts, and
 * so does `depd`, through `send`, in the standalone server.
 *
 * Not configurable once set, so nothing later in the process can put
 * `Function` back.
 */

const PROTOTYPES: ReadonlyArray<[() => object, string]> = [
  [() => Function.prototype, "Function"],
  [() => Object.getPrototypeOf(async function () {}), "AsyncFunction"],
  [() => Object.getPrototypeOf(function* () {}), "GeneratorFunction"],
  [() => Object.getPrototypeOf(async function* () {}), "AsyncGeneratorFunction"],
];

/** The marker each refusal carries, so a second lock knows the first ran. */
const LOCKED = Symbol.for("mixos.reflection-lock");

/** The message each refusal throws. */
export function refusalMessage(name: string): string {
  return (
    `${name} reached by reflection (\`.constructor\` on a function) is refused in this server: ` +
    "it runs a string as code. See docs/security-architecture.md §24."
  );
}

/**
 * Lock every function prototype's `constructor`. Runs once; a second call
 * changes nothing. Returns whether this call locked them.
 */
export function lockFunctionConstructors(): boolean {
  let locked = false;
  for (const [protoOf, name] of PROTOTYPES) {
    const proto = protoOf();
    const current = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value as
      | ({ [LOCKED]?: true } & object)
      | undefined;
    if (current && current[LOCKED]) continue;
    const refuse = {
      [name]: function () {
        throw new EvalError(refusalMessage(name));
      },
    }[name] as (() => never) & { [LOCKED]?: true };
    Object.defineProperty(refuse, LOCKED, { value: true });
    Object.defineProperty(proto, "constructor", {
      value: refuse,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    locked = true;
  }
  return locked;
}
