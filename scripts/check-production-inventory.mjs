import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDeployTarget, validateDeployInputs } from './deploy-digitalocean.mjs';

// Fixed, credential-free read-only inventory. No restart, upload or release changes.
export const INVENTORY_SCRIPT = String.raw`set -euo pipefail
metadata=http://169.254.169.254/metadata/v1
droplet_id=$(curl -fsS --max-time 3 "$metadata/id")
case "$droplet_id" in ''|*[!0-9]*) exit 1;; esac
printf 'provider=digitalocean\n'
printf 'droplet_id=%s\n' "$droplet_id"
printf 'service=%s\n' "$(systemctl is-active zen-content-hub || true)"
printf 'active_commit=%s\n' "$(cat /opt/zen-content-hub/.deploy-commit)"
systemctl show zen-content-hub --property=MemoryCurrent,MemoryPeak,NRestarts,TasksCurrent --no-pager
printf 'load=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
printf 'memory_kb=%s\n' "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
printf 'backup_timer=%s\n' "$(systemctl is-active zen-content-hub-backup.timer || true)"
systemctl show zen-content-hub-backup.service --property=Result,ExecMainStatus,ExecMainExitTimestamp --no-pager
latest=$(sudo -n find /var/lib/zen-content-hub/backups -maxdepth 1 -type f -name 'backup-*.sha256' -printf '%T@ %f\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')
if [ -n "$latest" ]; then
  printf 'latest_backup=%s\n' "$latest"
  if (cd /var/lib/zen-content-hub/backups && sudo -n sha256sum -c "$latest" >/dev/null 2>&1); then printf 'backup_checksums=ok\n'; else printf 'backup_checksums=failed\n'; fi
else printf 'latest_backup=missing\n'; fi
printf 'backup_related_units_begin\n'
systemctl list-unit-files --no-pager --no-legend | awk 'tolower($1) ~ /backup|restic|rclone|borg/ {print $1, $2}'
printf 'backup_related_units_end\n'
printf 'offsite_backup=not_proven_by_host_inventory\n'
`;

export function inventoryProduction() {
  const target = loadDeployTarget();
  validateDeployInputs({ target, commit: '0'.repeat(40), model: 'fixture', plannerModel: 'fixture', reasoning: 'low', plannerReasoning: 'low' });
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'bash -s'], {
    input: INVENTORY_SCRIPT, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`只读生产检查未完成: ${result.error?.message || result.stderr?.trim() || result.status}`);
  const id = /^droplet_id=(\d+)$/m.exec(result.stdout)?.[1];
  if (!id) throw new Error('缺少经 metadata 验证的 Droplet ID');
  const backups = spawnSync('doctl', ['compute', 'droplet', 'backups', id, '--output', 'json', '--http-retry-max', '0'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  let proof = 'provider_backups=unverified (CLI unavailable or account access unavailable)';
  if (backups.status === 0) {
    const images = JSON.parse(backups.stdout);
    if (!Array.isArray(images)) throw new Error('备份 API 返回形状不符');
    const dates = images.map(image => image.created_at).filter(Boolean).sort();
    proof = `provider_backup_count=${images.length}\nprovider_backup_latest=${dates.at(-1) || 'none'}`;
  }
  return `${result.stdout}${proof}\n`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(inventoryProduction()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
