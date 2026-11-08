/** "What should we build next?" and similar asks go to MUSE instead of starting a mission. */
export const asksForIdeas = (t: string): boolean =>
  /\b(suggest(ion)?s?|ideas?)\b/i.test(t) || /what (should|can|could|do) (we|i|you)[^.?]*\b(build|add|improve|make)[^.?]*\b(next|now)\b/i.test(t) || /what'?s next\b/i.test(t);
