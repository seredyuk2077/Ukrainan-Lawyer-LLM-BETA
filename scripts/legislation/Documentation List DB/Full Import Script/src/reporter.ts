import { writeJsonFileAtomic } from './utils.js';

export async function writeReport(reportPath: string, report: unknown): Promise<void> {
  await writeJsonFileAtomic(reportPath, report);
}

