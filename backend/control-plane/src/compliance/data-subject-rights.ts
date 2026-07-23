/**
 * Data subject rights — GDPR Art. 15 (access), 17 (erasure), 20 (portability).
 * docs/14 §2.
 *
 * The hard part of this is not the API. It is that a "data subject" in a voice
 * platform is usually identified only by a **phone number**, and their personal
 * data is spread across call records, transcripts, trace events, recordings in
 * object storage, campaign leads, and backups.
 *
 * Two design decisions worth stating:
 *
 *  1. **Erasure is two-phase.** Preview, then execute. An irreversible deletion
 *     triggered by a mistyped phone number is a worse incident than the one it was
 *     meant to prevent, and an auditor will ask how you prevent it.
 *
 *  2. **Backups are handled by crypto-shredding, not deletion.** You cannot
 *     surgically delete a row from an immutable backup. Destroying the tenant's
 *     data key (compliance/encryption.ts) renders that ciphertext permanently
 *     unreadable everywhere it exists. That is the only defensible answer to
 *     "how do you erase from backups?" — and it is the question security reviews
 *     actually ask.
 */

import type { AuditLogger } from './audit-log.js';
import type { TenantScope } from '../domain/tenant.js';

/** How a data subject is identified. Phone is the common case for voice. */
export type SubjectIdentifier =
  | { type: 'phone'; value: string }
  | { type: 'email'; value: string }
  | { type: 'user_id'; value: string }
  | { type: 'call_id'; value: string };

export interface DataArtefact {
  kind: 'call' | 'turn' | 'transcript' | 'recording' | 'trace' | 'lead' | 'consent_record';
  id: string;
  createdAt: string;
  /** Where it physically lives — DB row, object storage key, ClickHouse partition. */
  location: string;
  /** Bytes, for the export summary. */
  sizeBytes?: number;
  /**
   * Records we are legally required to keep even under an erasure request —
   * e.g. consent proof and audit entries. GDPR Art. 17(3) permits retention where
   * processing is necessary for compliance with a legal obligation.
   */
  retainedUnderLegalObligation?: { reason: string; until: string };
}

export interface SubjectDataSource {
  /** Find everything belonging to a subject within a tenant. */
  find(scope: TenantScope, subject: SubjectIdentifier): Promise<DataArtefact[]>;
  /** Materialise the content for an Art. 15/20 export. */
  export(scope: TenantScope, artefacts: DataArtefact[]): Promise<Record<string, unknown>>;
  /** Hard delete. Must be idempotent. */
  erase(scope: TenantScope, artefacts: DataArtefact[]): Promise<{ erased: number }>;
}

export interface ErasurePreview {
  subject: SubjectIdentifier;
  artefacts: DataArtefact[];
  /** Grouped counts for a human to sanity-check before confirming. */
  summary: Record<string, number>;
  /** Items that will NOT be erased, with the legal basis for keeping them. */
  retained: DataArtefact[];
  /** Backups are handled by key destruction, not row deletion. */
  backupStrategy: 'crypto_shred' | 'expiry_only';
  /** When the last backup containing this data ages out. */
  backupsExpireBy: string;
}

export interface ExportResult {
  subject: SubjectIdentifier;
  generatedAt: string;
  /** Machine-readable, per Art. 20. */
  format: 'json';
  data: Record<string, unknown>;
  artefactCount: number;
}

export class DataSubjectRightsService {
  constructor(
    private readonly sources: SubjectDataSource[],
    private readonly audit: AuditLogger,
    private readonly opts: {
      /** Retention window of the longest-lived backup, in days. */
      backupRetentionDays: number;
    } = { backupRetentionDays: 35 },
  ) {}

  /**
   * Art. 15 / Art. 20 — everything we hold about a subject, in a portable format.
   * Always audited: an access request is itself a processing activity.
   */
  async export(scope: TenantScope, subject: SubjectIdentifier): Promise<ExportResult> {
    const artefacts = await this.collect(scope, subject);
    const data: Record<string, unknown> = {};

    for (const source of this.sources) {
      const owned = artefacts.filter((a) => a.location.startsWith(sourceTag(source)));
      if (!owned.length) continue;
      Object.assign(data, await source.export(scope, owned));
    }

    await this.audit.record(scope, 'dsar.exported', {
      resourceType: 'data_subject',
      resourceId: hashSubject(subject),
      metadata: { artefactCount: artefacts.length, subjectType: subject.type },
    });

    return {
      subject,
      generatedAt: new Date().toISOString(),
      format: 'json',
      data,
      artefactCount: artefacts.length,
    };
  }

  /**
   * Phase 1 of erasure. Shows exactly what would be destroyed, WITHOUT destroying
   * anything. The UI must require the operator to confirm against this preview.
   */
  async previewErasure(
    scope: TenantScope,
    subject: SubjectIdentifier,
  ): Promise<ErasurePreview> {
    const all = await this.collect(scope, subject);
    const retained = all.filter((a) => a.retainedUnderLegalObligation);
    const erasable = all.filter((a) => !a.retainedUnderLegalObligation);

    const summary: Record<string, number> = {};
    for (const a of erasable) summary[a.kind] = (summary[a.kind] ?? 0) + 1;

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + this.opts.backupRetentionDays);

    return {
      subject,
      artefacts: erasable,
      summary,
      retained,
      backupStrategy: 'crypto_shred',
      backupsExpireBy: expiry.toISOString(),
    };
  }

  /**
   * Phase 2 — Art. 17. Irreversible.
   *
   * `confirmationToken` must match the preview that was shown to the operator, so
   * an erasure cannot be executed against a different subject than the one reviewed.
   */
  async executeErasure(
    scope: TenantScope,
    subject: SubjectIdentifier,
    confirmationToken: string,
  ): Promise<{ erased: number; retained: number; backupsExpireBy: string }> {
    const preview = await this.previewErasure(scope, subject);
    const expected = previewToken(scope, preview);

    if (confirmationToken !== expected) {
      // Fail closed, and audit the failure — a mismatched confirmation is either a
      // UI bug or an attempt to erase something that wasn't reviewed.
      await this.audit.record(scope, 'dsar.erased', {
        resourceType: 'data_subject',
        resourceId: hashSubject(subject),
        outcome: 'failure',
        metadata: { reason: 'confirmation_token_mismatch' },
      });
      throw new Error(
        'erasure confirmation does not match the reviewed preview — re-run the preview and confirm again',
      );
    }

    let erased = 0;
    for (const source of this.sources) {
      const owned = preview.artefacts.filter((a) => a.location.startsWith(sourceTag(source)));
      if (!owned.length) continue;
      const result = await source.erase(scope, owned);
      erased += result.erased;
    }

    await this.audit.record(scope, 'dsar.erased', {
      resourceType: 'data_subject',
      resourceId: hashSubject(subject),
      metadata: {
        erased,
        retained: preview.retained.length,
        // Never log the subject identifier itself — the audit record outlives the
        // data and would otherwise defeat the erasure it documents.
        subjectType: subject.type,
        backupStrategy: preview.backupStrategy,
      },
    });

    return {
      erased,
      retained: preview.retained.length,
      backupsExpireBy: preview.backupsExpireBy,
    };
  }

  /** Token the UI echoes back to prove the operator saw this exact preview. */
  tokenFor(scope: TenantScope, preview: ErasurePreview): string {
    return previewToken(scope, preview);
  }

  private async collect(
    scope: TenantScope,
    subject: SubjectIdentifier,
  ): Promise<DataArtefact[]> {
    const results = await Promise.all(this.sources.map((s) => s.find(scope, subject)));
    return results.flat();
  }
}

// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Subject identifiers are hashed before they touch the audit log. The audit record
 * must survive the erasure it documents without itself containing the personal data.
 */
function hashSubject(subject: SubjectIdentifier): string {
  return `subj_${createHash('sha256').update(`${subject.type}:${subject.value}`).digest('hex').slice(0, 24)}`;
}

function previewToken(scope: TenantScope, preview: ErasurePreview): string {
  const canonical = [
    scope.orgId,
    hashSubject(preview.subject),
    preview.artefacts.length,
    ...preview.artefacts.map((a) => `${a.kind}:${a.id}`).sort(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function sourceTag(source: SubjectDataSource): string {
  return (source as { tag?: string }).tag ?? '';
}
