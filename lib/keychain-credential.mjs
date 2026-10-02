import { spawnSync } from 'node:child_process';

export function loadKeychainCredential(service, username) {
  if (!service || !username) throw new Error('keychain_account_not_configured');
  const p = spawnSync('/usr/bin/security', [
    'find-generic-password', '-a', username, '-s', service, '-w',
  ], { encoding: 'utf8', timeout: 10000 });
  if (p.status !== 0) throw new Error('keychain_credential_unavailable');
  return { username, password: p.stdout.replace(/\r?\n$/, '') };
}
