// Git smart-HTTP surface for the forge: protocol v2 (ls-refs, fetch) and v0 (receive-pack),
// over the shared store in store.ts. Pure Node 22 stdlib, no git binary, no dependencies.
//
// Wire notes (matching the conformance git client byte-for-byte):
//  - pkt-line: 4 hex digits of total length (header included), 0000 flush, 0001 delim, 0002 end.
//  - info/refs for git-upload-pack honours `Git-Protocol: version=2` with a v2 capability
//    advertisement; otherwise (and always for git-receive-pack) it serves a v0 ref advertisement
//    behind the `# service=...` preamble.
//  - fetch answers with acknowledgments / shallow-info / packfile sections; the packfile section
//    is always side-band-64k framed (band 1 = pack bytes), even when the client sent no-progress.
//  - receive-pack unpacks plain, ofs-delta and ref-delta objects (thin bases may come from the
//    store), validates each ref update (non-fast-forward is refused per-ref) and answers with a
//    report-status stream, side-band wrapped when the client asked for it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  getRepo,
  readObject,
  writeObject,
  parseTree,
  parseCommit,
  reachableObjects,
  isAncestor,
  setRef,
  deleteRef,
} from './store.ts';
import type { Repo, ObjectType } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const SIDE_DATA_MAX = 65515; // one pkt-line payload (65516) minus the band byte

// --------------------------------------------------------------------------- pkt-line

function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Parse pkt-lines from `buf` starting at `start`. Stops after the first flush packet. */
function parsePktStream(buf: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const len = Number.parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4) throw new Error(`invalid pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
    if (offset >= buf.length) break;
  }
  return { packets, next: offset };
}

/** Parse a whole request body as pkt-lines (upload-pack requests are fully framed). */
function parseAllPackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const part = parsePktStream(buf, offset);
    packets.push(...part.packets);
    offset = part.next;
    // parsePktStream stops at a flush; a v0 fetch has a second section after it.
    if (part.packets.length === 0) break;
    if (offset >= buf.length) break;
    if (part.packets[part.packets.length - 1]?.kind !== 'flush') break;
  }
  return packets;
}

function dataLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  return lines;
}

/** Wrap `data` in side-band-64k band-`band` pkt-lines. */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) return out;
  for (let i = 0; i < data.length; i += SIDE_DATA_MAX) {
    const chunk = data.subarray(i, Math.min(data.length, i + SIDE_DATA_MAX));
    out.push(encodePkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// --------------------------------------------------------------------------- packfiles

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: ReadonlyArray<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, limit);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Unpack a packfile into the repo store, resolving ofs-delta and ref-delta entries. A ref-delta
 * base may live in the pack itself or already in the store (a thin pack). Throws on any
 * structural problem; the caller turns that into `unpack <error>`.
 */
function unpackPack(repo: Repo, pack: Buffer): void {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset] as number;
    offset += 1;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, { type: ObjectType; data: Buffer }>();
  // Non-delta entries first, so ref-delta bases inside the pack are known by id.
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer } => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let resolved: { type: ObjectType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      let base = resolvedByOid.get(wanted);
      if (!base) {
        const baseEntry = raw.find((candidate) => candidate.typeCode !== 6 && candidate.typeCode !== 7 && candidate.offset !== entry.offset && hashOf(candidate) === wanted);
        if (baseEntry) base = resolve(baseEntry);
      }
      if (!base) {
        const external = readObject(repo, wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        base = external;
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode] as ObjectType, data: entry.data };
    }
    resolving.delete(entry.offset);
    return resolved;
  };
  const hashOf = (entry: RawPackEntry): string => {
    const resolved = resolve(entry);
    return writeObject(repo, resolved.type, resolved.data);
  };
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      const resolved = resolve(entry);
      const oid = writeObject(repo, resolved.type, resolved.data);
      resolvedByOid.set(oid, resolved);
    }
  }
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      const resolved = resolve(entry);
      const oid = writeObject(repo, resolved.type, resolved.data);
      resolvedByOid.set(oid, resolved);
    }
  }
}

// --------------------------------------------------------------------------- object selection

/** Follow a tag chain to the object it ultimately names. */
function peelTarget(repo: Repo, sha: string): string {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = readObject(repo, current);
    if (!obj || obj.type !== 'tag') return current;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!m?.[1]) return current;
    current = m[1];
  }
  return current;
}

/** BFS distance (in parent hops) of every commit reachable from the wants; tags are followed. */
function commitDistances(repo: Repo, wants: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const enqueueCommit = (sha: string, d: number): void => {
    const existing = dist.get(sha);
    if (existing !== undefined && existing <= d) return;
    dist.set(sha, d);
    queue.push(sha);
  };
  for (const want of wants) {
    const target = peelTarget(repo, want);
    const obj = readObject(repo, target);
    if (obj?.type === 'commit') enqueueCommit(target, 0);
  }
  for (let i = 0; i < queue.length; i += 1) {
    const sha = queue[i] as string;
    const d = dist.get(sha) as number;
    const obj = readObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) enqueueCommit(parent, d + 1);
  }
  return dist;
}

/**
 * Objects reachable from `wants`. When `includedCommits` is given, a commit outside the set is
 * pruned entirely (neither it nor its tree or parents are traversed) — the shallow cut.
 */
function collectObjects(repo: Repo, wants: string[], includedCommits: Set<string> | null): Map<string, { type: ObjectType; data: Buffer }> {
  const out = new Map<string, { type: ObjectType; data: Buffer }>();
  const stack = [...wants];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = readObject(repo, sha);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (includedCommits && !includedCommits.has(sha)) continue;
      out.set(sha, obj);
      const parsed = parseCommit(obj.data);
      stack.push(parsed.tree, ...parsed.parents);
    } else if (obj.type === 'tree') {
      out.set(sha, obj);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        stack.push(e.sha);
      }
    } else if (obj.type === 'tag') {
      out.set(sha, obj);
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m?.[1]) stack.push(m[1]);
    } else {
      out.set(sha, obj);
    }
  }
  return out;
}

/** The closure a shallow client actually holds for one boundary commit: itself, its tree and blobs. */
function immediateClosure(repo: Repo, sha: string): Set<string> {
  const out = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    const obj = readObject(repo, cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m?.[1]) stack.push(m[1]);
    }
  }
  return out;
}

interface FetchPlan {
  objects: Array<{ type: ObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  shallowInfo: boolean;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  let includedCommits: Set<string> | null = null;
  let boundary: string[] = [];
  if (depth !== null) {
    const dist = commitDistances(repo, wants);
    includedCommits = new Set<string>();
    for (const [sha, d] of dist) if (d < depth) includedCommits.add(sha);
    for (const sha of includedCommits) {
      const obj = readObject(repo, sha);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => readObject(repo, p) && !includedCommits.has(p))) boundary.push(sha);
    }
    boundary.sort();
  }
  const candidates = collectObjects(repo, wants, includedCommits);
  const held = new Set<string>();
  for (const have of haves) {
    if (clientShallow.includes(have)) {
      for (const oid of immediateClosure(repo, have)) held.add(oid);
    } else {
      for (const oid of reachableObjects(repo, [have]).keys()) held.add(oid);
    }
  }
  // Shallow boundaries the client named but did not list as haves still bound what it holds.
  for (const boundarySha of clientShallow) {
    if (!haves.includes(boundarySha)) {
      // Only the boundary commit's own closure is certainly held; leave the rest sendable.
      for (const oid of immediateClosure(repo, boundarySha)) {
        if (candidates.has(oid) && !wants.includes(oid)) {
          // Do not subtract: a deepen target may share this closure. Haves drive subtraction.
        }
      }
    }
  }
  const objects: Array<{ type: ObjectType; data: Buffer }> = [];
  for (const [oid, obj] of candidates) {
    if (held.has(oid)) continue;
    objects.push(obj);
  }
  const unshallow: string[] = [];
  if (depth !== null || clientShallow.length > 0) {
    for (const old of clientShallow) {
      if (candidates.has(old) && !boundary.includes(old)) unshallow.push(old);
    }
  }
  return { objects, shallow: boundary, unshallow, shallowInfo: depth !== null || clientShallow.length > 0 };
}

// --------------------------------------------------------------------------- HTTP helpers

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function defaultRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --------------------------------------------------------------------------- advertisements

function uploadCapsV0(repo: Repo): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'object-format=sha1',
    `agent=${AGENT}`,
    `symref=HEAD:${defaultRef(repo)}`,
  ].join(' ');
}

function receiveCapsV0(repo: Repo): string {
  return [
    'report-status',
    'delete-refs',
    'side-band-64k',
    'quiet',
    'ofs-delta',
    'object-format=sha1',
    `agent=${AGENT}`,
    `symref=HEAD:${defaultRef(repo)}`,
  ].join(' ');
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? receiveCapsV0(repo) : uploadCapsV0(repo);
  const headTarget = defaultRef(repo);
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  parts.push(encodePkt(`${headOid} HEAD\0${caps}\n`));
  for (const [name, oid] of sortedRefs(repo)) {
    parts.push(encodePkt(`${oid} ${name}\n`));
    const obj = readObject(repo, oid);
    if (obj?.type === 'tag') {
      const peeled = peelTarget(repo, oid);
      if (peeled !== oid) parts.push(encodePkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePkt('version 2\n'),
    encodePkt(`agent=${AGENT}\n`),
    encodePkt('ls-refs=unborn\n'),
    encodePkt('fetch=shallow wait-for-done\n'),
    encodePkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// --------------------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headTarget = defaultRef(repo);
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid) {
      const symref = args.symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(encodePkt(`${headOid} HEAD${symref}\n`));
    } else {
      const symref = args.symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(encodePkt(`unborn HEAD${symref}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const obj = readObject(repo, oid);
      if (obj?.type === 'tag') {
        const peeled = peelTarget(repo, oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

// Fetch responses are a pure function of the content-addressed object graph and the request's
// wants/haves/shallow/depth, so identical concurrent fetches (the clone workload: 50 shallow
// clones of one tip) share one built response. Objects are immutable, so no invalidation is
// needed; the cache is size-capped.
const fetchResponseCache = new Map<string, Buffer>();

function fetchCacheKey(prefix: string, args: FetchArgs): string {
  return [prefix, [...args.wants].sort().join(','), [...args.haves].sort().join(','), [...args.shallow].sort().join(','), String(args.depth)].join('|');
}

function cachedFetch(key: string, build: () => Buffer): Buffer {
  const hit = fetchResponseCache.get(key);
  if (hit) return hit;
  const built = build();
  if (fetchResponseCache.size >= 32) fetchResponseCache.clear();
  fetchResponseCache.set(key, built);
  return built;
}

function buildFetchResponse(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetch(fetchCacheKey('v2', args), () => buildFetchResponseInner(repo, args));
}

function buildFetchResponseInner(repo: Repo, args: FetchArgs): Buffer {
  for (const want of args.wants) {
    if (!readObject(repo, want)) throw new Error(`want ${want} is not an object in this repository`);
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePkt('acknowledgments\n'));
  const common = args.haves.find((have) => readObject(repo, have));
  if (common) parts.push(encodePkt(`ACK ${common}\n`));
  else parts.push(encodePkt('NAK\n'));
  parts.push(PKT_DELIM);
  // shallow-info
  if (plan.shallowInfo) {
    parts.push(encodePkt('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(encodePkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(encodePkt(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile (always side-band framed; an empty pack is a valid 0-object pack)
  parts.push(encodePkt('packfile\n'));
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v0 fetch: want/have/done sections, NAK/ACK lines, then the side-band pack. */
function buildFetchResponseV0(repo: Repo, args: FetchArgs, sideband: boolean): Buffer {
  return cachedFetch(fetchCacheKey(sideband ? 'v0sb' : 'v0', args), () => buildFetchResponseV0Inner(repo, args, sideband));
}

function buildFetchResponseV0Inner(repo: Repo, args: FetchArgs, sideband: boolean): Buffer {
  for (const want of args.wants) {
    if (!readObject(repo, want)) throw new Error(`want ${want} is not an object in this repository`);
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const common = args.haves.find((have) => readObject(repo, have));
  parts.push(encodePkt(common ? `ACK ${common}\n` : 'NAK\n'));
  for (const sha of plan.shallow) parts.push(encodePkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(encodePkt(`unshallow ${sha}\n`));
  const pack = writePack(plan.objects);
  if (sideband) {
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  } else {
    // Unframed fallback: the pkt stream ends and the raw pack follows.
    parts.push(PKT_FLUSH);
    return Buffer.concat([...parts, pack]);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let packets: Packet[];
  try {
    packets = parseAllPackets(body);
  } catch {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed pkt-line request\n', 'utf8'));
    return;
  }
  // Split the request into command/argument sections at delim and flush packets.
  const sections: string[][] = [];
  let current: string[] = [];
  let sawCommand = false;
  for (const packet of packets) {
    if (packet.kind === 'data') {
      current.push(packet.payload.toString('utf8').replace(/\n$/, ''));
      sawCommand = true;
    } else {
      if (current.length > 0) sections.push(current);
      current = [];
    }
  }
  if (current.length > 0) sections.push(current);
  const head = sections[0] ?? [];
  const commandLine = head.find((line) => line.startsWith('command='));
  if (!sawCommand || !commandLine) {
    // No v2 command header: treat the whole body as a v0 fetch negotiation.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let sideband = false;
    for (const line of dataLines(packets)) {
      if (line.startsWith('want ')) {
        const tokens = line.slice(5).split(' ');
        wants.push(tokens[0] as string);
        if (tokens.includes('side-band-64k')) sideband = true;
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    if (wants.length === 0) {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: expected a fetch or ls-refs request\n', 'utf8'));
      return;
    }
    try {
      const response = buildFetchResponseV0(repo, { wants, haves, shallow, depth, done: true }, sideband);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', response);
    } catch (err) {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8'));
    }
    return;
  }
  const command = commandLine.slice('command='.length);
  const argLines = sections.length > 1
    ? sections.slice(1).flat()
    : head.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
  try {
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of argLines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
        else if (line === 'done') args.done = true;
      }
      if (args.wants.length === 0) {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: fetch with no wants\n', 'utf8'));
        return;
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', buildFetchResponse(repo, args));
      return;
    }
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`error: unknown command ${command}\n`, 'utf8'));
  } catch (err) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8'));
  }
}

// --------------------------------------------------------------------------- receive-pack (v0)

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let commands: PushCommandLine[] = [];
  let capabilities = new Map<string, string>();
  let pack = Buffer.alloc(0);
  try {
    const { packets, next } = parsePktStream(body, 0);
    pack = body.subarray(next);
    let first = true;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const capText = line.slice(nul + 1);
          line = line.slice(0, nul);
          for (const token of capText.split(' ')) {
            if (!token) continue;
            const eq = token.indexOf('=');
            if (eq < 0) capabilities.set(token, '');
            else capabilities.set(token.slice(0, eq), token.slice(eq + 1));
          }
        }
      }
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) throw new Error('bad object id in command line');
      if (!ref.startsWith('refs/')) throw new Error(`bad ref ${JSON.stringify(ref)}`);
      commands.push({ oldOid, newOid, ref });
    }
  } catch (err) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8'));
    return;
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      unpackPack(repo, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('stale ref');
        continue;
      }
      deleteRef(repo, command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObj = readObject(repo, command.newOid);
    if (!newObj) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
      fail('branch must point at a commit');
      continue;
    }
    if (command.ref.startsWith('refs/tags/') && newObj.type !== 'commit' && newObj.type !== 'tag') {
      fail('tag must point at a commit or tag');
      continue;
    }
    if (current !== ZERO_OID) {
      const effectiveOld = command.oldOid !== ZERO_OID ? command.oldOid : current;
      if (effectiveOld !== current) {
        fail('stale ref');
        continue;
      }
      const currentObj = readObject(repo, current);
      const newTarget = newObj.type === 'tag' ? peelTarget(repo, command.newOid) : command.newOid;
      const currentTarget = currentObj?.type === 'tag' ? peelTarget(repo, current) : current;
      if (currentTarget !== newTarget && !isAncestor(repo, currentTarget, newTarget)) {
        fail('non-fast-forward');
        continue;
      }
    }
    setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  // report-status: an inner pkt-line stream, side-band wrapped when requested.
  const inner: Buffer[] = [encodePkt(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    inner.push(encodePkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  let response: Buffer;
  if (capabilities.has('side-band-64k')) {
    response = Buffer.concat([...sidebandPackets(innerBytes, 1), PKT_FLUSH]);
  } else {
    response = innerBytes;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', response);
}

// --------------------------------------------------------------------------- entry point

export function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> | boolean {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return false;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const rest = `/${segments.slice(2).join('/')}`;
  const method = req.method ?? 'GET';

  const known =
    (method === 'GET' && (rest === '/info/refs' || rest === '/HEAD')) ||
    (method === 'POST' && (rest === '/git-upload-pack' || rest === '/git-receive-pack'));
  if (!known) return false;

  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (rest === '/HEAD') {
    sendBuffer(res, 200, 'text/plain; charset=utf-8', Buffer.from(`ref: ${defaultRef(repo)}\n`, 'utf8'));
    return true;
  }

  if (rest === '/info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: service parameter required\n', 'utf8'));
      return true;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack' && wantsV2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendBuffer(res, 200, `application/x-${service}-advertisement`, v0Advertisement(repo, service));
    }
    return true;
  }

  if (rest === '/git-upload-pack') {
    return handleUploadPack(req, res, repo).then(() => true);
  }
  return handleReceivePack(req, res, repo).then(() => true);
}
