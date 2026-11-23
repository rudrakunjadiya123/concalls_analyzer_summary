/**
 * @typedef {import('@finosauras/shared').NormalizedFiling} NormalizedFiling
 * @typedef {NormalizedFiling['company'] & { identityVerifiedAt?: string | null }} KnownCompany
 * @typedef {{ from: Date, to: Date, company?: KnownCompany, signal?: AbortSignal }} DiscoveryWindow
 * @typedef {{ records: NormalizedFiling[], complete: boolean, fetchedPages: number,
 *   providerCursor?: string, diagnostics: object }} DiscoveryResult
 * @typedef {{ enabled: boolean, mode: 'authorized' | 'fixture' | 'disabled_permission',
 *   lastSuccessAt: string | null, status: string, reason?: string }} SourceHealth
 * @typedef {import('node:stream').Readable & { headers?: Record<string, string>, complete?: boolean }} AttachmentStream
 * @callback DownloadAttachment
 * @template T
 * @param {string} url
 * @param {{ signal?: AbortSignal }} options
 * @param {(stream: AttachmentStream, signal?: AbortSignal) => Promise<T>} consume
 * @returns {Promise<T>}
 *
 * @typedef {{ source: NormalizedFiling['source'], cacheNamespace: string,
 *   allowedAttachment(url: string): boolean, download: DownloadAttachment,
 *   enabled: boolean, guard(): void,
 *   eligible(company: KnownCompany): boolean, discover(window: DiscoveryWindow): Promise<DiscoveryResult>,
 *   health(): SourceHealth }} FilingSource
 */

// An omitted company means market-wide discovery. All adapters return normalized filings.
export { discoveryResultSchema, sourceHealthSchema } from "@finosauras/shared";
