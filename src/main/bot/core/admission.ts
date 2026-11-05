/**
 * SPDX-License-Identifier: MIT
 * Adapted from DSH src/admission.ts (MIT); attribution and license: ./NOTICE.md.
 * Per-scope admission matrix; a listed sender addressing the agent is always explicit.
 */
import type { AdmissionCell } from './model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ['inferred', 'ignore'],
  unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'],
} as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore',
}
