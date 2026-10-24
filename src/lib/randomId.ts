/**
 * crypto.randomUUID() only exists in secure contexts (HTTPS or localhost)
 * — a plain http://<lan-ip>:4000 connection, the normal way another
 * device on the home network (or the admin tool) reaches the server,
 * isn't one, so calling it there throws "crypto.randomUUID is not a
 * function". None of this app's client-side ids are security-sensitive
 * (device ids, admin-only draft keys for a not-yet-saved light group,
 * etc. — never an auth credential), so a plain Math.random()-based
 * UUID v4 is a fine fallback when the real one isn't available.
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
