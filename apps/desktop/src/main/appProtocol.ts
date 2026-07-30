// The scoped custom protocol used to serve packaged renderer assets. Preferred
// over adding file:// read paths (see the security rule §7). Shared by the
// window loader and the protocol registration so they never drift.
export const APP_PROTOCOL = 'hearth';
