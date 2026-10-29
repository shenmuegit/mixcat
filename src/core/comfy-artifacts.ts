import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactRef } from '../shared/comfy.js';
import { insideProject, projectDirectory } from './paths.js';

const limit = 512 * 1024 * 1024;
const mimes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' };
export async function registerArtifact(root: string, path: string, snapshot = false): Promise<ArtifactRef> {
  path = insideProject(root, resolve(root, path));
  const mime = mimes[extname(path).toLowerCase()]; if (!mime) throw Error('Unsupported native artifact type.');
  const hash = createHash('sha256'); let bytes = 0;
  const id = randomUUID(), destination = snapshot ? insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy', 'artifacts'), id + extname(path))) : path;
  const inspect = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > limit) { callback(Error('Native artifact too large.')); return; } hash.update(chunk); callback(null, chunk); } });
  try {
    if (snapshot) { await pipeline(createReadStream(path), inspect, createWriteStream(destination, { flags: 'wx', mode: 0o600 })); const file = await open(destination, 'r+'); try { await file.sync(); } finally { await file.close(); } }
    else { for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > limit) throw Error('Native artifact too large.'); hash.update(chunk); } }
    return { id, relativePath: relative(root, destination), bytes, sha256: hash.digest('hex'), mime };
  } catch (error) { if (snapshot) await unlink(destination).catch(() => {}); throw error; }
}
export async function verifiedArtifactPath(root: string, artifact: ArtifactRef): Promise<string> {
  const path = insideProject(root, resolve(root, artifact.relativePath)), actual = await registerArtifact(root, path);
  if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256 || actual.mime !== artifact.mime) throw Error('Artifact integrity check failed.');
  return path;
}
