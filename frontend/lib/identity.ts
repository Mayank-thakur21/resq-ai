/**
 * Short tag of the signed-in identity, used to tell which account device-stored data belongs
 * to without keeping the account id itself in localStorage.
 *
 * FNV-1a (32 bit, hex): not a secret or a security boundary (the id is not secret either),
 * only a "same person as before?" check. Anonymous visitors get `""`.
 */
export function identityTag(userId: string | null | undefined): string {
  if (!userId) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `u${hash.toString(16).padStart(8, "0")}`;
}
