import { t } from './i18n.js';

/** Count recorded local actions, keeping refusals and process polls out of executed work. */
export function executionRecap(calls: readonly HTMLElement[]): string {
  let commands = 0, files = 0, edits = 0, other = 0, failed = 0;
  for (const call of calls) {
    const { toolKind: kind, outcome } = call.dataset;
    if (outcome && outcome !== 'ok' && outcome !== 'process_exit_nonzero') { failed++; continue; }
    if (kind === 'run') commands++;
    else if (kind === 'read') files += Number(call.dataset.fileCount) || 1;
    else if (['edit', 'create', 'delete', 'move'].includes(kind ?? '')) edits++;
    else other++;
  }
  const parts: string[] = [];
  if (commands) parts.push(commands === 1 ? t('Executed 1 command') : t('Executed {0} commands', [commands]));
  if (files) parts.push(files === 1 ? t('Read 1 file') : t('Read {0} files', [files]));
  if (edits) parts.push(edits === 1 ? t('1 edit') : t('{0} edits', [edits]));
  if (other) parts.push(other === 1 ? t('1 other action') : t('{0} other actions', [other]));
  if (failed) parts.push(failed === 1 ? t('1 failed action') : t('{0} failed actions', [failed]));
  return parts.join(' · ');
}
