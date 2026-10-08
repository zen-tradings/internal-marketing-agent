import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function ssh(target, command, input = '') {
  try {
    return execFileSync('ssh', [...sshOptions, target, command], {
      input, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    // execFileSync.message contains the whole command. Keep operational errors
    // short and never echo source/payload or configuration contents.
    throw new Error(`Maintenance SSH failed: ${String(error.stderr || error.code || 'connection error').trim().slice(0, 1500)}`);
  }
}

export async function maintainProduction({ target, activeCommit, apply = false, retireQdii = false }) {
  if (!/^[a-z_][a-z0-9_-]*@[a-z0-9_.:-]+$/i.test(target) || !/^[a-f0-9]{40}$/i.test(activeCommit)) throw new Error('Invalid maintenance target');
  const inventory = ssh(target, 'python3 -', `import glob,json\nout=[]\nfor p in glob.glob('/opt/zen-content-hub.rollback-*')+glob.glob('/opt/zen-content-hub.release-*'):\n try: out.append(open(p+'/.deploy-commit').read().strip())\n except OSError: pass\nprint(json.dumps(out))\n`);
  const commits = [...new Set(JSON.parse(inventory))].filter(sha => /^[a-f0-9]{40}$/.test(sha));
  // Git archives establish byte-for-byte reproducibility; never trust age/name.
  const manifestBuilder = `import sys,json,subprocess,tarfile,io,hashlib\nout={}\nfor commit in json.load(sys.stdin):\n try:\n  archive=subprocess.check_output(['git','archive',commit])\n  entries={}\n  with tarfile.open(fileobj=io.BytesIO(archive)) as tar:\n   for member in tar:\n    if member.isfile():entries[member.name]={'type':'file','sha256':hashlib.sha256(tar.extractfile(member).read()).hexdigest()}\n    elif member.issym():entries[member.name]={'type':'symlink','target':member.linkname}\n  out[commit]=entries\n except subprocess.CalledProcessError:pass\nprint(json.dumps(out))\n`;
  const releases = JSON.parse(execFileSync('python3', ['-c', manifestBuilder], {
    cwd: root, input: JSON.stringify(commits), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  }));
  const source = fs.readFileSync(path.join(root, 'deploy/zen-content-hub-maintenance.py'), 'utf8');
  const job = `zen-maintenance-${crypto.randomUUID()}`;
  const prefix = `/tmp/${job}`;
  // Detached, supervised and bounded: a lost connection cannot trigger a second
  // destructive run. Status/output remain available for explicit reconciliation.
  const bootstrap = `import json,sys,os,subprocess\np=json.load(sys.stdin)\nos.umask(0o077)\nf=p['prefix']\nopen(f+'.py','w').write(p['source'])\nopen(f+'.json','w').write(json.dumps(p['payload']))\nopen(f+'.status','w').write('running')\nrunner='#!/bin/bash\\nset +e\\nnice -n 15 python3 '+f+'.py < '+f+'.json > '+f+'.out 2> '+f+'.err\\ncode=$?\\nprintf "%s" "$code" > '+f+'.status.tmp\\nmv '+f+'.status.tmp '+f+'.status\\nexit "$code"\\n'\nopen(f+'.sh','w').write(runner)\nsubprocess.run(['systemd-run','--quiet','--no-block','--unit='+p['job'],'--property=RuntimeMaxSec=1200','/bin/bash',f+'.sh'],check=True)\nprint(json.dumps({'job':p['job'],'status':f+'.status'}))\n`;
  try {
    ssh(target, `python3 -c ${shellQuote(bootstrap)}`, JSON.stringify({ source, prefix, job,
      payload: { activeCommit, releases, apply, retireQdii } }));
  } catch (error) {
    throw new Error(`${error.message}. Dispatch outcome unknown; inspect ${prefix}.status before any new maintenance run.`);
  }
  const inspect = `import json,subprocess\nf="${prefix}"\ns=open(f+'.status').read()\nu=subprocess.run(['systemctl','show','-p','ActiveState','--value','${job}'],capture_output=True,text=True).stdout.strip()\nprint(json.dumps({'state':s,'unit':u,'output':open(f+'.out').read() if s!='running' else '', 'error':open(f+'.err').read()[-2000:] if s!='running' else ''}))`;
  const started = Date.now();
  while (Date.now() - started < 21 * 60000) {
    await delay(15000);
    let status;
    try { status = JSON.parse(ssh(target, `python3 -c ${shellQuote(inspect)}`)); }
    catch (error) { throw new Error(`${error.message}. Job may still be running; inspect ${prefix}.status before retrying.`); }
    if (status.state === 'running') {
      if (status.unit === 'failed' || status.unit === 'inactive') throw new Error(`Maintenance stopped without a result; inspect ${prefix}.err and ${job}`);
      continue;
    }
    if (status.state !== '0') throw new Error(`Maintenance failed: ${status.error}. Details retained at ${prefix}.err`);
    const result = JSON.parse(status.output);
    try { ssh(target, `rm -f ${prefix}.py ${prefix}.json ${prefix}.sh ${prefix}.status ${prefix}.out ${prefix}.err`); } catch {}
    return result;
  }
  throw new Error(`Maintenance timed out; inspect ${prefix}.status before retrying.`);
}
