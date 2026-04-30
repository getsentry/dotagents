import type { TrustConfig } from "./schema.js";
import type { TrustPolicy } from "@sentry/dotagents-lib";

/**
 * Compile-time guarantee that the host's `TrustConfig` (zod-inferred from
 * `agents.toml`) structurally satisfies the lib's `TrustPolicy` interface.
 *
 * If this file fails to compile after a schema change, the host's trust shape
 * has drifted from the lib's expectations — fix one or the other before the
 * resolver's `trust?` opt silently accepts a misshapen policy.
 *
 * This file emits a tiny no-op assignment at runtime; it is here for the type
 * check, not the runtime behavior.
 */
const _trustPolicyConformance: (t: TrustConfig) => TrustPolicy = (t) => t;
export const __trustPolicyConformance = _trustPolicyConformance;
