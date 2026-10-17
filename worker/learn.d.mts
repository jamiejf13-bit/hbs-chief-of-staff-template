/**
 * Types for learn.mjs, which the API route needs and the worker does not.
 *
 * The alternative was reimplementing the tokeniser in TypeScript for the route
 * to call. Two copies of "which words a decision teaches" would drift, and the
 * drift would be invisible: the route would record one set of tokens and the
 * scorer would look up another, so your decisions would quietly stop having any
 * effect. A declaration file keeps one implementation.
 */

export interface PersonLike {
  employer?: string | null;
  title?: string | null;
}

export interface Signal {
  up: number;
  down: number;
}

/** The words a decision about this person should teach. */
export function tokensFor(person: PersonLike): string[];

/** What your decisions have taught, derived from the people rows themselves. */
export function loadSignals(sql: unknown): Promise<Map<string, Signal>>;

/** How far learning may move a score in either direction. */
export const CAP: number;

/** The learned adjustment for one person, capped at ±CAP. */
export function learnedAdjustment(
  signals: Map<string, Signal> | null,
  person: PersonLike,
): { delta: number; reason: string | null };
