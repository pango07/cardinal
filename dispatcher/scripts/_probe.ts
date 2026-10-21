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
T=app/src/test/kotlin/com/spotterclass/app/store/DataStoreKeyValueStoreTest.kt
report() { grep -E 'testsuite name="com.spotterclass.app.store.DataStoreKeyValueStoreTest"' app/build/test-results/testDevDebugUnitTest/*.xml | grep -oE 'tests="[0-9]+" skipped="[0-9]+" failures="[0-9]+" errors="[0-9]+"' | head -1; grep -c "testcase" app/build/test-results/testDevDebugUnitTest/*.xml | awk -F: '{s+=$2} END {print "total testcases:", s}'; }

echo "== A: IO pool 512 threads, test file unchanged"
start=$(date +%s)
JAVA_TOOL_OPTIONS="-Dkotlinx.coroutines.io.parallelism=512" ./gradlew -q --no-daemon -PskipScreenshots=true :app:testDevDebugUnitTest > /tmp/a.log 2>&1 && echo "A: PASS ($(( $(date +%s)-start ))s)" || { echo "A: FAIL ($(( $(date +%s)-start ))s)"; grep -E "FAILED$|tests completed" /tmp/a.log | head -5; }
report

echo "== B: dedicated single-thread dispatcher for the DataStore scopes"
sed -i 's/Dispatchers\\.IO/DS_DISPATCHER/g' $T
sed -i '0,/^class DataStoreKeyValueStoreTest {/s//@OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class, kotlinx.coroutines.ExperimentalCoroutinesApi::class)\\nprivate val DS_DISPATCHER = kotlinx.coroutines.newSingleThreadContext("datastore-test")\\n\\nclass DataStoreKeyValueStoreTest {/' $T
grep -n "DS_DISPATCHER" $T | head -3
start=$(date +%s)
./gradlew -q --no-daemon -PskipScreenshots=true :app:testDevDebugUnitTest > /tmp/b.log 2>&1 && echo "B: PASS ($(( $(date +%s)-start ))s)" || { echo "B: FAIL ($(( $(date +%s)-start ))s)"; grep -E "FAILED$|tests completed|^e: " /tmp/b.log | head -5; }
report`;
  const r = await s.runCommand({ cmd: 'bash', args: ['-c', script] });
  console.log('exit', r.exitCode); console.log((await r.stdout()).replace(new RegExp(token, 'g'), '***')); console.log((await r.stderr()).slice(-1500).replace(new RegExp(token, 'g'), '***'));
} finally { await s.stop(); }
