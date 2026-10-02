// Packs extension/ into dist/spool-<version>.zip (what you upload to a release or the Chrome Web Store). No dependencies:
// a small ZIP writer on top of node:zlib. Only the files of the extension are included, never tests or dev tooling.
//
//   npm run pack
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // fixed stamp: the same sources always give the same archive
const entries = [];
const parts = [];
let offset = 0;
const push = (buffer) => {
  parts.push(buffer);
  offset += buffer.length;
};

for (const path of walk(source)) {
  const name = relative(source, path).split(sep).join('/');
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const method = packed.length < data.length ? 8 : 0;
  const body = method === 8 ? packed : data;
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  entries.push({ nameBytes, method, crc: crc32(data), packedSize: body.length, size: data.length, offset });
  push(header);
  push(nameBytes);
  push(body);
}

const directoryStart = offset;
for (const e of entries) {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4); // made by
  record.writeUInt16LE(20, 6); // needed
  record.writeUInt16LE(0x0800, 8);
  record.writeUInt16LE(e.method, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(e.crc, 16);
  record.writeUInt32LE(e.packedSize, 20);
  record.writeUInt32LE(e.size, 24);
  record.writeUInt16LE(e.nameBytes.length, 28);
  record.writeUInt32LE(e.offset, 42);
  push(record);
  push(e.nameBytes);
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(offset - directoryStart, 12);
end.writeUInt32LE(directoryStart, 16);
push(end);

mkdirSync(join(root, 'dist'), { recursive: true });
const file = join(root, 'dist', `spool-${version}.zip`);
writeFileSync(file, Buffer.concat(parts));
console.log(`wrote dist/spool-${version}.zip (${entries.length} files, ${Buffer.concat(parts).length} bytes)`);
