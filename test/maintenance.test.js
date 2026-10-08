import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('maintenance preserves unique release data and damaged backups; deletes complete expired units; deduplicates safely', () => {
  const source = `
import importlib.util,tempfile,os,json,time,hashlib
spec=importlib.util.spec_from_file_location('maintenance','deploy/zen-content-hub-maintenance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 release=os.path.join(root,'release');os.mkdir(release)
 source=os.path.join(release,'app.js');open(source,'w').write('tracked')
 expected={'app.js':{'type':'file','sha256':m.sha256(source)}}
 assert m.release_clean(release,expected)
 open(os.path.join(release,'unique.txt'),'w').write('user data')
 assert not m.release_clean(release,expected)
 os.unlink(os.path.join(release,'unique.txt'));open(source,'w').write('changed')
 assert not m.release_clean(release,expected)
 backup=os.path.join(root,'backups');os.mkdir(backup)
 def unit(stamp,age=0):
  names=['runs-'+stamp+'.db','artifacts-'+stamp+'.tar.gz']
  for name in names:open(os.path.join(backup,name),'wb').write(b'identical recovery content')
  manifest=os.path.join(backup,'backup-'+stamp+'.sha256')
  open(manifest,'w').write(''.join(m.sha256(os.path.join(backup,name))+'  '+name+'\\n' for name in names))
  os.utime(manifest,(time.time()-age*86400,)*2)
  return manifest,names
 old,old_names=unit('20261001T000000Z',7)
 damaged,damaged_names=unit('20261002T000000Z',6)
 open(os.path.join(backup,damaged_names[0]),'ab').write(b'tamper')
 newest,new_names=unit('20261008T000000Z')
 archive=os.path.join(backup,new_names[1]);assert m.deduplicate_backup_archive(archive,backup)
 assert os.stat(archive).st_ino==os.stat(os.path.join(backup,old_names[1])).st_ino
 result=m.prune_backups(backup,3,True)
 assert result['removed']==1 and result['preservedInvalid']==1
 assert os.path.exists(damaged) and not os.path.exists(old)
 assert open(archive,'rb').read()==b'identical recovery content'
 # A corrupt latest recovery point prevents all pruning.
 open(os.path.join(backup,new_names[0]),'ab').write(b'tamper')
 try:m.prune_backups(backup,3,True);assert False
 except ValueError:pass
print('maintenance safety passed')
`;
  const result = spawnSync('python3', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
