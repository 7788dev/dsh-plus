//#region lib/types/invariant.js
/** Package-owned invariant companion. @module dsh-plus/invariant */
const PACKAGE_NAME = "dsh-plus";
/** Cordis companion plugin name. */
const name = "mcp-settings-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the JSON document is the authority, and mcp-client
* child fibers are derived from it rather than independently snapshotted.
*/
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
