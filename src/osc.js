// Minimal OSC 1.0 codec.
// The RCV frames every packet with a 4-byte LITTLE-endian byte count; the OSC
// payload inside that frame is standard big-endian OSC. Only the prefix is LE.

const strLen = (s) => Math.ceil((Buffer.byteLength(s, 'ascii') + 1) / 4) * 4;

function writeString(s) {
  const buf = Buffer.alloc(strLen(s));
  buf.write(s, 0, 'ascii');
  return buf;
}

// Type inference matches osc-js, which is what the RØDE/Bitfocus module uses:
// integers -> 'i', other numbers -> 'f', strings -> 's', buffers -> 'b'.
// This matters: /show/transition_time is sent as a STRING of milliseconds.
function tagFor(arg) {
  if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) return 'b';
  if (typeof arg === 'string') return 's';
  if (typeof arg === 'boolean') return 'i';
  if (typeof arg === 'number') return Number.isInteger(arg) ? 'i' : 'f';
  throw new Error(`Unsupported OSC argument type: ${typeof arg}`);
}

function writeArg(arg, tag) {
  switch (tag) {
    case 's': return writeString(arg);
    case 'i': {
      const b = Buffer.alloc(4);
      b.writeInt32BE(typeof arg === 'boolean' ? (arg ? 1 : 0) : arg, 0);
      return b;
    }
    case 'f': {
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg, 0);
      return b;
    }
    case 'b': {
      const data = Buffer.from(arg);
      const b = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
      b.writeUInt32BE(data.length, 0);
      data.copy(b, 4);
      return b;
    }
    default: throw new Error(`Unsupported OSC tag: ${tag}`);
  }
}

export function encodeMessage(address, args = []) {
  const tags = args.map(tagFor);
  const parts = [writeString(address), writeString(`,${tags.join('')}`)];
  args.forEach((a, i) => parts.push(writeArg(a, tags[i])));
  return Buffer.concat(parts);
}

// Wraps an encoded message in the RCV's little-endian length prefix.
export function frame(address, args = []) {
  const body = encodeMessage(address, args);
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

function readString(buf, offset) {
  const end = buf.indexOf(0, offset);
  if (end === -1) throw new Error('Unterminated OSC string');
  return { value: buf.toString('ascii', offset, end), offset: Math.ceil((end + 1 - offset) / 4) * 4 + offset };
}

export function decodeMessage(buf) {
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('Not an OSC message');

  let offset = addr.offset;
  const args = [];

  if (offset < buf.length) {
    const tagPart = readString(buf, offset);
    offset = tagPart.offset;

    for (const tag of tagPart.value.slice(1)) {
      switch (tag) {
        case 'i': args.push(buf.readInt32BE(offset)); offset += 4; break;
        case 'f': args.push(buf.readFloatBE(offset)); offset += 4; break;
        case 'h': args.push(buf.readBigInt64BE(offset)); offset += 8; break;
        case 'd': args.push(buf.readDoubleBE(offset)); offset += 8; break;
        case 's':
        case 'S': { const s = readString(buf, offset); args.push(s.value); offset = s.offset; break; }
        case 'b': {
          const size = buf.readUInt32BE(offset);
          args.push(buf.subarray(offset + 4, offset + 4 + size));
          offset += 4 + Math.ceil(size / 4) * 4;
          break;
        }
        case 'T': args.push(true); break;
        case 'F': args.push(false); break;
        case 'N': args.push(null); break;
        case 'I': args.push(Infinity); break;
        default: throw new Error(`Unsupported OSC tag in response: ${tag}`);
      }
    }
  }

  return { address: addr.value, args };
}

// Bundles arrive as '#bundle\0' + 8-byte timetag + (int32BE size + packet)*
export function decodePacket(buf) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const messages = [];
    let offset = 16;
    while (offset + 4 <= buf.length) {
      const size = buf.readInt32BE(offset);
      offset += 4;
      if (size <= 0 || offset + size > buf.length) break;
      try { messages.push(...decodePacket(buf.subarray(offset, offset + size))); } catch { /* skip bad element */ }
      offset += size;
    }
    return messages;
  }
  return [decodeMessage(buf)];
}
