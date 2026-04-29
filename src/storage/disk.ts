import { statfsSync } from "node:fs";

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export function checkDiskSpace(path: string): DiskSpace {
  const s = statfsSync(path);
  return {
    freeBytes: Number(s.bavail) * Number(s.bsize),
    totalBytes: Number(s.blocks) * Number(s.bsize),
  };
}

export function assertDiskSpace(path: string, minBytes: number): void {
  const { freeBytes } = checkDiskSpace(path);
  if (freeBytes < minBytes) {
    const freeMb = Math.floor(freeBytes / 1024 / 1024);
    const minMb = Math.floor(minBytes / 1024 / 1024);
    throw new Error(`disk space too low: ${freeMb}MB free, need at least ${minMb}MB at ${path}`);
  }
}

export const MIN_DISK_BYTES_DEFAULT = 500 * 1024 * 1024;
