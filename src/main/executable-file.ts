import { accessSync, constants, existsSync, statSync } from 'node:fs';

/** Check an existing regular file for launch permission on this platform. */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
