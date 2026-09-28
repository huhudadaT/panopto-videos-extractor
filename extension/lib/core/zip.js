// Minimal ZIP writer. Stored (no compression) — slide JPEGs are already
// compressed, so deflate would only cost time. Emits a plain Uint8Array so it
// works in a service worker, an offscreen document, or Node under test.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function encodeName(name) {
  return new TextEncoder().encode(name.replace(/\\/g, "/"));
}

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  u16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value & 0xffff, true);
    this.push(b);
  }

  u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.push(b);
  }

  concat() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/**
 * @param {Array<{name: string, bytes: Uint8Array, date?: Date}>} entries
 * @returns {Uint8Array} a complete .zip file
 */
export function createZip(entries, options = {}) {
  const now = options.date instanceof Date ? options.date : new Date();
  const writer = new Writer();
  const central = [];

  for (const entry of entries) {
    const nameBytes = encodeName(entry.name);
    const data =
      entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
    const checksum = crc32(data);
    const stamp = dosDateTime(entry.date instanceof Date ? entry.date : now);
    const localOffset = writer.length;

    writer.u32(0x04034b50); // local file header
    writer.u16(20); // version needed
    writer.u16(0x0800); // UTF-8 names
    writer.u16(0); // stored
    writer.u16(stamp.time);
    writer.u16(stamp.date);
    writer.u32(checksum);
    writer.u32(data.byteLength);
    writer.u32(data.byteLength);
    writer.u16(nameBytes.byteLength);
    writer.u16(0); // extra length
    writer.push(nameBytes);
    writer.push(data);

    central.push({ nameBytes, checksum, size: data.byteLength, stamp, localOffset });
  }

  const centralStart = writer.length;
  for (const item of central) {
    writer.u32(0x02014b50); // central directory header
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(item.stamp.time);
    writer.u16(item.stamp.date);
    writer.u32(item.checksum);
    writer.u32(item.size);
    writer.u32(item.size);
    writer.u16(item.nameBytes.byteLength);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // disk number
    writer.u16(0); // internal attrs
    writer.u32(0); // external attrs
    writer.u32(item.localOffset);
    writer.push(item.nameBytes);
  }
  const centralSize = writer.length - centralStart;

  writer.u32(0x06054b50); // end of central directory
  writer.u16(0);
  writer.u16(0);
  writer.u16(central.length);
  writer.u16(central.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0);

  return writer.concat();
}

/** Read back the stored entry names — used by tests and sanity checks. */
export function listZipEntries(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder();
  const names = [];
  let offset = 0;
  while (offset + 30 <= zipBytes.byteLength) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    names.push({
      name: decoder.decode(zipBytes.subarray(nameStart, nameStart + nameLength)),
      size: compressedSize,
      dataOffset: nameStart + nameLength + extraLength,
    });
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return names;
}
