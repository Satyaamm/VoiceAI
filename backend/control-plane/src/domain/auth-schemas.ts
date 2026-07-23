/**
 * Auth & onboarding input schemas.
 *
 * Separate from `schemas.ts` because these are *input* shapes for the identity
 * surface, and because their sequencing is the whole onboarding thesis: signup
 * asks for two fields, and every other schema in this file is collected
 * just-in-time, at the moment its data is actually needed (docs/11 §Revised).
 *
 * Read the order of declarations as the order a user meets them:
 *   signup -> verify -> (talk to an agent) -> details -> billing -> invites -> keys
 */

import { z } from 'zod';

import {
  isoCountry,
  modeSchema,
  orgRoleSchema,
  phoneNumberValueSchema,
  postalAddressSchema,
  workspaceRoleSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Normalised at the edge so `Foo@Bar.com` and `foo@bar.com` are one identity. */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((e) => e.toLowerCase());

/**
 * Length is the only rule that survives contact with reality. Composition rules
 * ("one symbol, one digit") push users toward `Password1!` and measurably weaken
 * the corpus, so we set a real floor instead and cap at 200 to bound scrypt cost
 * (an unbounded password is a cheap way to burn CPU on a login endpoint).
 */
export const passwordSchema = z
  .string()
  .min(10, 'use at least 10 characters — length beats symbols')
  .max(200);

/** Exactly six digits. Leading zeros are significant, so this stays a string. */
export const verificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'expected a 6-digit code');

/** Opaque, high-entropy, URL-safe. Issued by the invitation service. */
export const opaqueTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'malformed token');

// ---------------------------------------------------------------------------
// 1. Signup — email + password, and nothing else.
// ---------------------------------------------------------------------------

/**
 * Optional context is *inferred*, never asked for (docs/11 §4): country from IP,
 * timezone and locale from the browser. The client may pass what it detected;
 * the server falls back to safe defaults if it doesn't.
 */
export const signupInput = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** Detected client-side. Purely a hint — used to name/branch the auto-provisioned org. */
  country: isoCountry.optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(20).optional(),
  /** Set when the user arrived from an invite link; joins that org instead of provisioning one. */
  inviteToken: opaqueTokenSchema.optional(),
});

export const loginInput = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  /** Optional org anchor for users who belong to several orgs. */
  orgId: z.string().min(3).max(64).optional(),
});

// ---------------------------------------------------------------------------
// 2. Email verification — a 6-digit code, not a magic link.
//    A link breaks when signup and inbox are on different devices (docs/10).
// ---------------------------------------------------------------------------

export const verifyEmailInput = z.object({
  /** Optional: an authenticated session already identifies the user. */
  email: emailSchema.optional(),
  code: verificationCodeSchema,
});

export const resendVerificationInput = z.object({
  email: emailSchema.optional(),
});

// ---------------------------------------------------------------------------
// 3. User details — asked at the first invite or the first live call, because
//    that is when a name and a recovery number actually matter.
// ---------------------------------------------------------------------------

export const userDetailsInput = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    /** Stored with its country/dial code, not as a mangled single string. */
    phone: phoneNumberValueSchema.optional(),
    jobTitle: z.string().trim().max(120).optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(20).optional(),
    avatarUrl: z.string().url().max(2048).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 4. Org billing details — asked when a payment method is added. Structured
//    address, never freeform: an invoice line has to be machine-readable and a
//    tax authority does not accept "the big building on Oak Street".
// ---------------------------------------------------------------------------

export const orgBillingDetailsInput = z
  .object({
    /** "Acme Technologies GmbH" — what the invoice says, vs `name` which is what the UI says. */
    legalName: z.string().trim().min(1).max(200).optional(),
    address: postalAddressSchema.optional(),
    /** GSTIN / VAT / EIN — the label follows the country, see compliance.taxIdLabelFor. */
    taxId: z.string().trim().min(2).max(40).optional(),
    billingEmail: emailSchema.optional(),
    phone: phoneNumberValueSchema.optional(),
    /** Dismissible profile-card fields. Never a blocker (docs/11 §B). */
    website: z.string().url().max(2048).optional(),
    industry: z.string().trim().max(80).optional(),
    size: z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'provide at least one field to update',
  });

// ---------------------------------------------------------------------------
// 5. Invitations
// ---------------------------------------------------------------------------

export const workspaceGrantInput = z.object({
  workspaceId: z.string().min(3).max(64),
  role: workspaceRoleSchema,
});

export const inviteInput = z.object({
  email: emailSchema,
  /** Least privilege by default — an invite that silently grants admin is a bug. */
  role: orgRoleSchema.default('member'),
  /** Explicit per-workspace grants. Owners/admins get implicit access anyway. */
  workspaceGrants: z.array(workspaceGrantInput).max(50).default([]),
  /** Bounded so an invite cannot sit valid forever in an abandoned inbox. */
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

/**
 * Accepting works for someone who has no account yet: they supply a password and
 * a name in the same request and are provisioned into the inviting org — no
 * second signup, no duplicate personal org.
 */
export const acceptInviteInput = z
  .object({
    password: passwordSchema.optional(),
    firstName: z.string().trim().min(1).max(80).optional(),
    familyName: z.string().trim().min(1).max(80).optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(20).optional(),
  })
  .strict();

export const revokeInviteInput = z.object({
  invitationId: z.string().min(3).max(64),
});

// ---------------------------------------------------------------------------
// 6. API keys — workspace-scoped, mode-tagged.
// ---------------------------------------------------------------------------

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Defaults to the request's current mode, so a test session cannot mint a live key by omission. */
  mode: modeSchema.optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

// ---------------------------------------------------------------------------

export type SignupInput = z.infer<typeof signupInput>;
export type LoginInput = z.infer<typeof loginInput>;
export type VerifyEmailInput = z.infer<typeof verifyEmailInput>;
export type UserDetailsInput = z.infer<typeof userDetailsInput>;
export type OrgBillingDetailsInput = z.infer<typeof orgBillingDetailsInput>;
export type InviteInput = z.infer<typeof inviteInput>;
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;
export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;
export type WorkspaceGrantInput = z.infer<typeof workspaceGrantInput>;
