/**
 * Provider eligibility gate.
 *
 * docs/14 §3 item 4: a HIPAA-eligible workspace must be restricted to BAA-covered
 * providers **in code**, not in a policy document. Same mechanism enforces GDPR
 * residency: an EU-pinned workspace cannot route audio or transcripts to a US-only
 * vendor (Art. 44 international transfers).
 *
 * This is the control that turns "we're compliant" from a claim into a constraint.
 * It runs at TWO points, and both matter:
 *
 *   1. Configuration time — the dashboard only offers eligible providers, and
 *      saving an ineligible pipeline is rejected with a reason a human can act on.
 *   2. Dispatch time — re-checked before a call, because a workspace's compliance
 *      posture can change after an agent was configured.
 */

import type { DataBloc } from '../services/region.js';
import { REGION_META_BLOC } from '../services/region.js';
import type { ComplianceProfile, Region } from '../domain/schemas.js';

/**
 * The data-processing posture of a provider. Every provider must declare this;
 * an undeclared provider is treated as ineligible for everything regulated.
 *
 * This is the machine-readable half of SUBPROCESSORS.md — the document customers
 * ask for in procurement (docs/14 §3 item 7).
 */
export interface ProviderDataPosture {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  /** Where this provider physically processes data. */
  allowedBlocs: DataBloc[];
  /** Is a signed BAA in place? Required before any PHI may reach it. */
  baaSigned: boolean;
  /** Is a GDPR Art. 28 DPA in place? Required for any EU personal data. */
  dpaSigned: boolean;
  /** Does the vendor retain inputs (e.g. for abuse monitoring or training)? */
  retainsData: boolean;
  /** Does the vendor train on customer data? Disqualifying for most enterprises. */
  trainsOnData: boolean;
  selfHosted: boolean;
  /** Free text for the subprocessor register. */
  notes?: string;
}

export type IneligibilityReason =
  | 'residency_mismatch'
  | 'no_baa'
  | 'no_dpa'
  | 'retains_data'
  | 'trains_on_data'
  | 'undeclared_posture';

export interface EligibilityResult {
  eligible: boolean;
  reasons: Array<{ code: IneligibilityReason; message: string }>;
}

/** What the workspace's compliance posture demands of a provider. */
export interface EligibilityRequirements {
  /** Where this workspace's data must stay. */
  bloc: DataBloc;
  /** PHI in scope — HIPAA applies. */
  requiresBaa: boolean;
  /** EU personal data in scope — GDPR Art. 28 applies. */
  requiresDpa: boolean;
  /** Reject providers that retain inputs. */
  forbidRetention: boolean;
}

/**
 * Derives requirements from a workspace. Conservative by construction: EU regions
 * always demand a DPA, and HIPAA mode always demands a BAA and no retention.
 */
export function requirementsFor(
  region: Region,
  compliance: ComplianceProfile & { hipaaMode?: boolean },
): EligibilityRequirements {
  const bloc = REGION_META_BLOC[region];
  return {
    bloc,
    requiresBaa: compliance.hipaaMode === true,
    // Any EU-region workspace, or one permitted to call EU jurisdictions, is
    // handling EU personal data.
    requiresDpa: bloc === 'EU' || compliance.jurisdictions.some(isEuCountry),
    // Under HIPAA, a vendor retaining PHI beyond the request is a disclosure we
    // have not authorised. PII redaction reduces but does not eliminate this.
    forbidRetention: compliance.hipaaMode === true,
  };
}

export function checkEligibility(
  posture: ProviderDataPosture | undefined,
  req: EligibilityRequirements,
): EligibilityResult {
  const reasons: EligibilityResult['reasons'] = [];

  if (!posture) {
    return {
      eligible: false,
      reasons: [
        {
          code: 'undeclared_posture',
          message:
            'provider has no declared data-processing posture — it cannot be used in a ' +
            'regulated workspace until one is registered',
        },
      ],
    };
  }

  // Self-hosted providers run inside our own regional infrastructure, so residency
  // follows the cell and no third-party agreement is involved. This is precisely
  // why owning inference makes HIPAA and GDPR dramatically easier (docs/14 §1).
  if (posture.selfHosted) {
    return { eligible: true, reasons: [] };
  }

  if (!posture.allowedBlocs.includes(req.bloc)) {
    reasons.push({
      code: 'residency_mismatch',
      message:
        `"${posture.key}" processes data in ${posture.allowedBlocs.join('/') || 'an undeclared region'} ` +
        `but this workspace requires ${req.bloc}. Transferring here would be an ` +
        `international transfer requiring a separate lawful basis (GDPR Art. 44).`,
    });
  }

  if (req.requiresBaa && !posture.baaSigned) {
    reasons.push({
      code: 'no_baa',
      message:
        `"${posture.key}" has no signed Business Associate Agreement. PHI may not be ` +
        `disclosed to it (HIPAA §164.308(b)(1)). Use a self-hosted provider or obtain a BAA.`,
    });
  }

  if (req.requiresDpa && !posture.dpaSigned) {
    reasons.push({
      code: 'no_dpa',
      message:
        `"${posture.key}" has no signed Data Processing Agreement (GDPR Art. 28), which is ` +
        `required before EU personal data may be processed by a sub-processor.`,
    });
  }

  if (req.forbidRetention && posture.retainsData) {
    reasons.push({
      code: 'retains_data',
      message:
        `"${posture.key}" retains request data. A HIPAA-eligible workspace requires ` +
        `zero-retention processing.`,
    });
  }

  // Training on customer data is disqualifying in every regulated context, and in
  // most enterprise contracts regardless of regulation.
  if (posture.trainsOnData) {
    reasons.push({
      code: 'trains_on_data',
      message: `"${posture.key}" trains on customer data and cannot be used for customer conversations.`,
    });
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Registry of provider postures. Populated at boot alongside provider registration,
 * and rendered into SUBPROCESSORS.md.
 */
export class ProviderPostureRegistry {
  private readonly postures = new Map<string, ProviderDataPosture>();

  register(posture: ProviderDataPosture): this {
    this.postures.set(posture.key, posture);
    return this;
  }

  get(key: string): ProviderDataPosture | undefined {
    return this.postures.get(key);
  }

  all(): ProviderDataPosture[] {
    return [...this.postures.values()];
  }

  /** Providers a given workspace may select. Drives the dashboard's dropdowns. */
  eligibleFor(
    req: EligibilityRequirements,
    kind?: 'stt' | 'llm' | 'tts',
  ): ProviderDataPosture[] {
    return this.all().filter(
      (p) => (!kind || p.kind === kind) && checkEligibility(p, req).eligible,
    );
  }

  /**
   * Validates a whole pipeline. Called on agent save AND before dispatch — a
   * workspace can be switched into HIPAA mode after an agent was configured, and
   * that must invalidate the agent rather than silently keep routing PHI.
   */
  validatePipeline(
    pipeline: { sttProvider: string; llmProvider: string; ttsProvider: string },
    req: EligibilityRequirements,
  ): EligibilityResult {
    const reasons: EligibilityResult['reasons'] = [];
    for (const key of [pipeline.sttProvider, pipeline.llmProvider, pipeline.ttsProvider]) {
      reasons.push(...checkEligibility(this.get(key), req).reasons);
    }
    return { eligible: reasons.length === 0, reasons };
  }

  /** Generates the sub-processor register customers ask for in procurement. */
  toSubprocessorTable(): Array<Record<string, string>> {
    return this.all().map((p) => ({
      provider: p.key,
      purpose: p.kind.toUpperCase(),
      location: p.selfHosted ? 'Self-hosted (our infrastructure)' : p.allowedBlocs.join(', '),
      dpa: p.selfHosted ? 'N/A' : p.dpaSigned ? 'Signed' : 'Not signed',
      baa: p.selfHosted ? 'N/A' : p.baaSigned ? 'Signed' : 'Not signed',
      retention: p.retainsData ? 'Retains input' : 'Zero retention',
      notes: p.notes ?? '',
    }));
  }
}

const EU = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT',
  'LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO',
]);

function isEuCountry(country: string): boolean {
  return EU.has(country.toUpperCase());
}
