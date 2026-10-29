/**
 * Lets `node --test` import the app's TypeScript modules.
 *
 * Node 22 strips types (`--experimental-strip-types`) but does not rewrite
 * extensionless relative specifiers, which is how every TS file in `src/` imports
 * its siblings. This hook tries `<specifier>.ts` before giving up, so the tests
 * import the same files Vite bundles — no second copy of any module.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/i.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // fall through to the normal resolution (a real .js/.json sibling, or an error worth seeing)
    }
  }
  return next(specifier, context);
}
