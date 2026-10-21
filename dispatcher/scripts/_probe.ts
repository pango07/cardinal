import { Sandbox } from '@vercel/sandbox';
import { execFileSync } from 'node:child_process';
const token = execFileSync('gh', ['auth', 'token']).toString().trim();
const s = await Sandbox.create({ image: 'cardinal-runner-android:v0.4', persistent: false, timeout: 40 * 60_000, resources: { vcpus: 8 } });
try {
  const script = `
set -e
export $(cat ~/.env | xargs); export PATH="$(cat ~/.path)"
git clone -q --depth 1 --branch ci/cardinal https://x-access-token:${token}@github.com/pango07/class-management.git /home/runner/cm
cd /home/runner/cm/apps/android
for i in 1 2 3 4 5; do
  if ./gradlew -q --no-daemon -PskipScreenshots=true :app:testDevDebugUnitTest --tests '*DataStoreKeyValueStoreTest*' > /tmp/run$i.log 2>&1; then echo "run $i: PASS"; else echo "run $i: FAIL"; grep -E "FAILED|Exception" /tmp/run$i.log | head -4; fi
done`;
  const r = await s.runCommand({ cmd: 'bash', args: ['-c', script] });
  console.log('exit', r.exitCode); console.log((await r.stdout()).replace(new RegExp(token, 'g'), '***')); console.log((await r.stderr()).slice(-2000).replace(new RegExp(token, 'g'), '***'));
} finally { await s.stop(); }
