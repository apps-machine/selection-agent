/**
 * Public package entrypoint for `@apps-machine/selection-agent`.
 *
 * Consumers who install via npm and import the package as a library get
 * the typed Zod schemas + evaluator pure functions exported here. The CLI
 * lives in `src/cli/index.ts` (referenced by the `bin` field).
 */

export {
  buildDossier,
  DEFAULT_DOSSIER_TEMPLATE,
  type DossierOpts,
  findCandidate,
  parseCandidateRef,
  type Shortlist,
  type ShortlistCandidate,
} from "./path-e/dossier.ts";
export {
  type AnnotatedCandidate,
  type AnnotatedShortlist,
  type CheckName,
  type CheckStatus,
  evaluateCandidate,
  evaluateShortlist,
  type RiskCheck,
  type RiskCheckCandidate,
  type RiskCheckResult,
  type Verdict,
} from "./path-e/risk-check.ts";
export {
  DEFAULT_CLONABLE_DNA_CLASSES,
  DEFAULT_SUPPORTED_MARKETS,
  type RiskThresholds,
  RiskThresholdsSchema,
} from "./path-e/risk-thresholds.ts";
