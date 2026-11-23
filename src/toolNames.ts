/** Chat Completions rejects tool names longer than this (OpenAI and several
 * upstream providers behind the gateway). MCP tool names routinely exceed it. */
export const MAX_TOOL_NAME_LENGTH = 64;

export interface ToolNameAliases {
  /** Name to put on the wire for an editor-side tool name. */
  toWire(name: string): string;
  /** Editor-side name for a name received from the wire (unknown names pass through). */
  fromWire(wireName: string): string;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Digest of a tool name for its alias: 8 lowercase hex digits. */
type NameHash = (text: string) => string;

/** How many salted re-hashes to try before counting up instead. */
const SALTED_ATTEMPTS = 16;

/** `name` itself when it fits; otherwise a deterministic shortened form
 * `<prefix>_<8 hex digits of the name's hash>` that is exactly `maxLength` long. */
export function aliasToolName(
  name: string,
  maxLength: number = MAX_TOOL_NAME_LENGTH,
  hash: NameHash = fnv1a32Hex
): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 9)}_${hash(name)}`;
}

/** Remembers the way back for every name it is given, so tool calls streamed
 * from the gateway can be reported to the editor under their original name.
 *
 * Two different long names can end up with the same hash digits (8 hex digits
 * are only 32 bits). The first name keeps the alias `aliasToolName` gives it;
 * a later one whose alias is already in use gets another digest (its name
 * salted with an attempt number, then a plain counter), so no two names of one
 * request share a wire name. `hash` is injectable so a test can force that. */
export function createToolNameAliases(
  names: Iterable<string>,
  maxLength: number = MAX_TOOL_NAME_LENGTH,
  hash: NameHash = fnv1a32Hex
): ToolNameAliases {
  const originals = new Map<string, string>(); // alias -> original name
  const aliasOf = new Map<string, string>(); // original name -> alias
  const inUse = new Set<string>(); // every wire name handed out, short names too

  const uniqueAlias = (name: string): string => {
    const prefix = name.slice(0, maxLength - 9);
    for (let attempt = 0; ; attempt++) {
      let digits: string;
      if (attempt === 0) digits = hash(name);
      else if (attempt <= SALTED_ATTEMPTS) digits = hash(`${name}\u0000${attempt}`);
      else digits = (attempt - SALTED_ATTEMPTS).toString(16).padStart(8, "0");
      const candidate = `${prefix}_${digits}`;
      if (!inUse.has(candidate)) return candidate;
    }
  };

  const toWire = (name: string): string => {
    if (name.length <= maxLength) {
      inUse.add(name);
      return name;
    }
    let wire = aliasOf.get(name);
    if (wire === undefined) {
      wire = uniqueAlias(name);
      aliasOf.set(name, wire);
      originals.set(wire, name);
      inUse.add(wire);
    }
    return wire;
  };

  const all = [...names];
  // Names that fit go first: they keep their own name on the wire, so no alias may take it.
  for (const name of all) if (name.length <= maxLength) toWire(name);
  for (const name of all) toWire(name);
  return {
    toWire,
    fromWire: (wireName) => originals.get(wireName) ?? wireName,
  };
}
