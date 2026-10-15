// MH-18: a store product id carried through the film and back ("See it on
// your wall" out of the variant modal, "Back to my order" into the store). The
// film cannot know the catalogue, so it only accepts the id's shape and the
// store checks it against PRODUCTS before using it.
export function validProductId(v: string | null | undefined): string | null {
  return v && /^[a-z0-9_-]{1,64}$/.test(v) ? v : null;
}

