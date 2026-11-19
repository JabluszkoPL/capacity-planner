import type { ID } from "./types";

let uidCounter = 0;

/**
 * Generate a locally-unique id. Ids are opaque strings and are generated
 * client-side (never by the server) so that a device working offline can
 * create entities that keep their identity once they sync.
 */
export function newId(): ID {
  uidCounter++;
  return (
    "id" +
    Date.now().toString(36) +
    uidCounter +
    Math.random().toString(36).slice(2, 7)
  );
}
