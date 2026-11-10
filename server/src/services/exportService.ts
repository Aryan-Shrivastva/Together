import { lstat, readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { env } from '../config/env.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';

type ZipEntry = { name: string; content: Buffer; compressed: Buffer; crc: number; offset: number };

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function shouldExclude(name: string): boolean {
  const base = name.split('/').at(-1) ?? name;
  return (
    name.split('/').some((segment) => segment === '.git' || segment === 'node_modules') ||
    (base.startsWith('.env') && base !== '.env.example') ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  );
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    entry.offset = offset;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(8),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(entry.crc),
      writeUInt32(entry.compressed.length),
      writeUInt32(entry.content.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
      entry.compressed,
    ]);
    localParts.push(local);
    offset += local.length;
  });

  let centralSize = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const central = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(8),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(entry.crc),
      writeUInt32(entry.compressed.length),
      writeUInt32(entry.content.length),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(entry.offset),
      name,
    ]);
    centralParts.push(central);
    centralSize += central.length;
  });

  const locals = Buffer.concat(localParts);
  const centralOffset = locals.length;
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(centralSize),
    writeUInt32(centralOffset),
    writeUInt16(0),
  ]);
  return Buffer.concat([locals, ...centralParts, end]);
}

export class ExportService {
  async create(workspaceId: string): Promise<Buffer> {
    const root = workspaceService.getRoot(workspaceId);
    const files: Array<{ absolutePath: string; archivePath: string; size: number }> = [];
    let totalBytes = 0;

    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const absolutePath = resolve(directory, child.name);
        const archivePath = relative(root, absolutePath).replaceAll('\\', '/');
        if (shouldExclude(archivePath)) continue;
        const details = await lstat(absolutePath);
        if (details.isSymbolicLink()) continue;
        if (details.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!details.isFile()) continue;
        totalBytes += details.size;
        if (totalBytes > env.MAX_EXPORT_BYTES) {
          throw new HttpError(413, 'This workspace is too large to export.');
        }
        files.push({ absolutePath, archivePath, size: details.size });
      }
    };

    await visit(root);
    const entries: ZipEntry[] = [];
    for (const file of files) {
      const content = await readFile(file.absolutePath);
      if (content.length !== file.size)
        throw new HttpError(409, 'Workspace changed during export.');
      entries.push({
        name: file.archivePath,
        content,
        compressed: deflateRawSync(content),
        crc: crc32(content),
        offset: 0,
      });
    }
    return createZip(entries);
  }
}

export const exportService = new ExportService();
