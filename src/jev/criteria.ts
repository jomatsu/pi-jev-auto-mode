/**
 * Shared noul criteria.
 *
 * The default criteria matter more than they look. Jev is calibrated, and
 * `noul` has no `confidence` field: the only signal is the probability. If the
 * criteria leave the middle open, an ambiguous condition lands somewhere in the
 * middle and the two-sided thresholds in `decide.ts` can route it to a human.
 * If they force every answer to an extreme, "uncertain" stops existing and the
 * gate has to guess.
 */

import type { JevEntry } from "./types.ts";

export const DEFAULT_CRITERIA: { readonly true: JevEntry; readonly false: JevEntry } = {
  true: "The condition clearly holds for the item under validation.",
  false:
    "The condition clearly does not hold for the item under validation. " +
    "An item the state says nothing about, or that is too ambiguous to decide, is neither clearly true nor clearly false.",
};
