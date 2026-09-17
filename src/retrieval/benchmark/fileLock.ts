import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BenchmarkAdmissionError } from './admission.js';
import { benchmarkFilesystemStem, validateBenchmarkIdentifier } from './identifier.js';

export interface BenchmarkRunFileLock {
  readonly path: string;
  close(preserveMarker?: boolean): Promise<void>;
}

/** Cross-process marker used by the explicit benchmark entrypoint. */
export async function acquireBenchmarkRunFileLock(
  runId: string,
  directory: string
): Promise<BenchmarkRunFileLock> {
  validateBenchmarkIdentifier(runId, 'runId', 'run_in_use');
  await mkdir(directory, { recursive: true });
  // Encode the identifier so a valid logical run ID cannot become a
  // platform-specific filename (notably ':' on Windows).
  const path = join(directory, `${benchmarkFilesystemStem(runId)}.lock`);
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx');
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new BenchmarkAdmissionError('run_in_use', 'Benchmark run marker already exists');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ runId, status: 'in_progress' }) + '\n', 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    path,
    close: async preserveMarker => {
      if (closed) return;
      closed = true;
      try {
        if (preserveMarker) {
          await handle.truncate(0);
          const marker = Buffer.from(JSON.stringify({ runId, status: 'complete_or_interrupted' }) + '\n', 'utf8');
          await handle.write(marker, 0, marker.byteLength, 0);
        }
      } finally {
        await handle.close();
        if (!preserveMarker) await unlink(path).catch(() => undefined);
      }
    }
  };
}
