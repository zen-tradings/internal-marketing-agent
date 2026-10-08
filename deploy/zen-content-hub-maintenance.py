#!/usr/bin/env python3
"""Reviewed, bounded maintenance. Unknown/modified assets are never removed."""
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def release_clean(directory, expected):
    found = set()
    for root, dirs, files in os.walk(directory, followlinks=False):
        # Dependencies are rebuilt from the verified, tracked lockfiles.
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.venv')]
        for d in dirs:
            if os.path.islink(os.path.join(root, d)):
                return False
        for name in files:
            filename = os.path.join(root, name)
            relative = os.path.relpath(filename, directory)
            if relative == '.deploy-commit':
                continue
            if '__pycache__' in relative.split('/') and relative.endswith('.pyc'):
                continue
            entry = expected.get(relative)
            if entry is None:
                return False
            if entry['type'] == 'symlink':
                if not os.path.islink(filename) or os.readlink(filename) != entry['target']:
                    return False
            elif os.path.islink(filename) or sha256(filename) != entry['sha256']:
                return False
            found.add(relative)
    return found == set(expected)


def referenced(directory):
    for proc in glob.glob('/proc/[0-9]*'):
        for item in [proc + '/cwd', proc + '/exe'] + glob.glob(proc + '/fd/*'):
            try:
                target = os.readlink(item).removesuffix(' (deleted)')
                if target == directory or target.startswith(directory + '/'):
                    return True
            except OSError:
                pass
        try:
            if directory + '/' in open(proc + '/maps').read():
                return True
        except OSError:
            pass
    return False


def verify_backup(manifest):
    if os.path.islink(manifest):
        raise ValueError('Symlink backup manifest')
    entries = []
    stamp = re.fullmatch(r'backup-(\d{8}T\d{6}Z)\.sha256', os.path.basename(manifest))
    if not stamp:
        raise ValueError('Invalid backup name')
    suffix = stamp.group(1)
    allowed = {f'runs-{suffix}.db', f'artifacts-{suffix}.tar.gz', f'costs-{suffix}.db'}
    for line in open(manifest):
        match = re.fullmatch(r'([a-f0-9]{64})\s+\*?([a-zA-Z0-9_.-]+)\s*', line)
        if not match or match.group(2) not in allowed:
            raise ValueError('Invalid backup manifest')
        path = os.path.join(os.path.dirname(manifest), match.group(2))
        if os.path.islink(path) or sha256(path) != match.group(1):
            raise ValueError('Backup hash mismatch')
        entries.append(path)
    names = {os.path.basename(p) for p in entries}
    if len(names) != len(entries) or not {f'runs-{suffix}.db', f'artifacts-{suffix}.tar.gz'} <= names:
        raise ValueError('Incomplete backup unit')
    return entries


def prune_backups(directory, days=3, apply=False, now=None):
    now = time.time() if now is None else now
    manifests = sorted(glob.glob(os.path.join(directory, 'backup-*.sha256')), key=os.path.getmtime, reverse=True)
    if not manifests:
        return {'removed': 0, 'preserved': 0}
    # Verify the newest complete recovery point before removing any older unit.
    verify_backup(manifests[0])
    removed = 0
    preserved = 0
    for manifest in manifests[1:]:
        if os.path.getmtime(manifest) >= now - days * 86400:
            continue
        try:
            entries = verify_backup(manifest)
        except (OSError, ValueError):
            preserved += 1
            continue
        if apply:
            for entry in entries:
                os.unlink(entry)
            os.unlink(manifest)
        removed += 1
    return {'removed' if apply else 'eligible': removed, 'preservedInvalid': preserved}


def deduplicate_backup_archive(archive, directory):
    digest = sha256(archive)
    size = os.stat(archive).st_size
    for previous in sorted(glob.glob(os.path.join(directory, 'artifacts-*.tar.gz')), reverse=True):
        if previous == archive or os.path.islink(previous) or os.stat(previous).st_size != size:
            continue
        stamp = re.fullmatch(r'artifacts-(\d{8}T\d{6}Z)\.tar\.gz', os.path.basename(previous))
        manifest = os.path.join(directory, f'backup-{stamp.group(1)}.sha256') if stamp else ''
        try:
            if sha256(previous) != digest or previous not in verify_backup(manifest):
                continue
            temporary = archive + '.dedup'
            os.link(previous, temporary)
            os.replace(temporary, archive)
            return True
        except (OSError, ValueError):
            continue
    return False


def rehearse_recovery(manifest):
    rehearsal = """import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { restoreUnit } from '/opt/zen-content-hub/scripts/check-backup-restore.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'zen-maintenance-restore-'));
try { console.log(JSON.stringify(restoreUnit(process.argv[2],path.join(root,'restored')))); }
finally { fs.rmSync(root,{recursive:true,force:true}); }
"""
    subprocess.run(['node', '--input-type=module', '-', manifest], input=rehearsal, text=True,
                   capture_output=True, check=True, timeout=90)


def maintain(payload):
    os.umask(0o077)
    active = '/opt/zen-content-hub'
    expected_commit = payload['activeCommit']
    if open(active + '/.deploy-commit').read().strip() != expected_commit:
        raise ValueError('Active release changed')
    apply = payload.get('apply', False)
    before = shutil.disk_usage('/').free
    if apply:
        latest = max(glob.glob('/var/lib/zen-content-hub/backups/backup-*.sha256'), key=os.path.getmtime)
        verify_backup(latest)
        rehearse_recovery(latest)
    candidates = []
    for directory in glob.glob('/opt/zen-content-hub.rollback-*') + glob.glob('/opt/zen-content-hub.release-*'):
        if os.path.islink(directory) or not re.fullmatch(r'/opt/zen-content-hub\.(rollback|release)-[a-f0-9]{12}', directory):
            continue
        try:
            commit = open(directory + '/.deploy-commit').read().strip()
            expected = payload['releases'].get(commit)
            clean = expected is not None and release_clean(directory, expected)
            compatible = subprocess.run(['node', directory + '/scripts/check-rollback.mjs', '--db', '/var/lib/zen-content-hub/runs.db'], capture_output=True, timeout=15).returncode == 0
            candidates.append((directory, clean and compatible and not referenced(directory), os.path.getmtime(directory)))
        except (OSError, ValueError, subprocess.SubprocessError):
            candidates.append((directory, False, 0))
    validated = sorted([c for c in candidates if c[1] and '.rollback-' in c[0]], key=lambda c: c[2], reverse=True)
    keep = {c[0] for c in validated[:2]}
    if len(keep) < 2:
        raise ValueError('Two verified rollback releases are required before cleanup')
    removed = []
    preserved = []
    for directory, clean, _ in candidates:
        if directory in keep or not clean:
            preserved.append(os.path.basename(directory))
        else:
            if apply:
                shutil.rmtree(directory)
            removed.append(os.path.basename(directory))
    backups = prune_backups('/var/lib/zen-content-hub/backups', 3, apply)
    retired = False
    if payload.get('retireQdii'):
        # Archive the service, source and data without
        # printing any credential/config contents. Keep original data in place.
        unit = subprocess.check_output(['systemctl', 'cat', 'qdii-wechat'], text=True)
        if '/opt/qdii-wechat' not in unit:
            raise ValueError('Unexpected QDII service target')
        if apply:
            target = '/var/lib/zen-content-hub/retired-qdii-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.tar.gz'
            with tempfile.TemporaryDirectory(prefix='zen-retire-') as temporary:
                with open(temporary + '/qdii-wechat.service', 'w') as output:
                    output.write(unit)
                subprocess.run(['tar', '-czf', target, '-C', '/', 'opt/qdii-wechat', 'etc/qdii-wechat', '-C', temporary, 'qdii-wechat.service'], check=True)
            os.chmod(target, 0o600)
            subprocess.run(['gzip', '-t', target], check=True)
            subprocess.run(['systemctl', 'disable', '--now', 'qdii-wechat'], check=True, capture_output=True)
            retired = True
    return {'applied': apply, 'removedReleases' if apply else 'eligibleReleases': removed,
            'preservedReleases': preserved, 'backups': backups, 'qdiiRetired': retired,
            'verifiedRollbackReleases': sorted(keep), 'freeBytesBefore': before, 'freeBytesAfter': shutil.disk_usage('/').free}


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--prune-backups':
        manifests = glob.glob(os.path.join(sys.argv[2], 'backup-*.sha256'))
        if manifests:
            latest = max(manifests, key=os.path.getmtime)
            verify_backup(latest)
            rehearse_recovery(latest)
        print(json.dumps(prune_backups(sys.argv[2], int(sys.argv[3]), True)))
    elif len(sys.argv) == 4 and sys.argv[1] == '--deduplicate-archive':
        print(json.dumps({'deduplicated': deduplicate_backup_archive(sys.argv[2], sys.argv[3])}))
    else:
        print(json.dumps(maintain(json.load(sys.stdin))))
