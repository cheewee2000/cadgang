/**
 * Shared error type.
 *
 * Lives in its own module so the B-rep kernel can throw GraphError without
 * importing sdf.js (which imports the B-rep node registry, which imports the
 * kernel — a cycle). sdf.js re-exports GraphError, so existing importers are
 * unaffected.
 */

/** A modelling error the user can act on: bad params, bad wiring, failed op. */
export class GraphError extends Error {}
