// Builds the base VM once: source image + our SSH key + actions/runner. Per-job VMs are clones of it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, sshKeyPath } from './config.ts';
import { run } from './exec.ts';
import { latestRunner } from './github.ts';
import { log } from './log.ts';
import { boot, ssh, stopAndDelete, stopVm, tart, vmExists, waitForIp, waitForSsh } from './tart.ts';

export async function prepare(opts: { force?: boolean } = {}): Promise<void> {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(sshKeyPath)) {
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'cardinal-mac', '-f', sshKeyPath]);
    log('prepare', `generated ${sshKeyPath}`);
  }
  const pubKey = readFileSync(`${sshKeyPath}.pub`, 'utf8').trim();

  if (await vmExists(config.baseVm)) {
    if (!opts.force) {
      log('prepare', `${config.baseVm} already exists (use --force to rebuild)`);
      return;
    }
    await stopAndDelete(config.baseVm);
  }

  log('prepare', `cloning ${config.sourceImage} → ${config.baseVm} (pulls the image if needed)`);
  await tart('clone', config.sourceImage, config.baseVm);
  await tart('set', config.baseVm, '--cpu', String(config.cpu), '--memory', String(config.memoryMb));

  const proc = boot(config.baseVm);
  try {
    const ip = await waitForIp(config.baseVm);
    log('prepare', `base VM up at ${ip}; installing SSH key`);
    await installKeyWithPassword(ip, pubKey);
    await waitForSsh(ip);

    const rel = await latestRunner();
    log('prepare', `installing actions/runner ${rel.version}`);
    const tarball = join(tmpdir(), `actions-runner-osx-arm64-${rel.version}.tar.gz`);
    if (!existsSync(tarball)) {
      const res = await fetch(rel.url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    }
    const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    if (sha !== rel.sha256) throw new Error(`SHA mismatch for ${tarball}: ${sha} ≠ ${rel.sha256}`);
    await run('scp', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-i', sshKeyPath, tarball, `${config.guestUser}@${ip}:/tmp/runner.tar.gz`]);
    await ssh(ip, 'rm -rf ~/actions-runner && mkdir -p ~/actions-runner && tar -xzf /tmp/runner.tar.gz -C ~/actions-runner && rm /tmp/runner.tar.gz');
    await ssh(ip, `echo ${rel.version} > ~/actions-runner/.runner-version`);
    // The runner is started over non-interactive SSH, which has a bare PATH; the runner prepends .path for every job.
    await ssh(ip, `echo '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' > ~/actions-runner/.path`);
    log('prepare', 'installing xcodegen');
    await ssh(ip, 'export PATH=/opt/homebrew/bin:$PATH; brew install --quiet xcodegen', 20 * 60_000);

    if (config.android) {
      log('prepare', 'installing JDK 21 + Android SDK (Homebrew, inside the VM)');
      // Non-interactive SSH gets a bare PATH, so spell Homebrew out.
      const sdk = '/opt/homebrew/share/android-commandlinetools';
      const path = `export PATH=/opt/homebrew/bin:${sdk}/cmdline-tools/latest/bin:$PATH;`;
      await ssh(ip, `${path} brew install --quiet --cask temurin@21 android-commandlinetools`, 30 * 60_000);
      const packages = config.androidPackages.split(/\s+/).map((p) => `'${p}'`).join(' '); // `;` in package names
      await ssh(ip, `${path} yes | sdkmanager --licenses >/dev/null; sdkmanager --install ${packages} >/dev/null`, 30 * 60_000);
      // The runner loads .env into every job's environment.
      await ssh(ip, `printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nJAVA_HOME=%s\n' ${sdk} ${sdk} "$(/usr/libexec/java_home -v 21)" > ~/actions-runner/.env && cat ~/actions-runner/.env`);
    }

    const facts = await ssh(ip, 'sw_vers -productVersion; xcodebuild -version | head -1; ls /Applications | grep -i xcode | tr "\\n" " "; xcrun simctl list runtimes | grep -c iOS');
    log('prepare', `guest: ${facts.replace(/\n/g, ' | ')}`);

    log('prepare', 'shutting the base VM down');
    await ssh(ip, 'sudo shutdown -h now').catch(() => {});
  } finally {
    await stopVm(config.baseVm, proc);
  }
  log('prepare', `${config.baseVm} is ready`);
}

/** First login uses the image's password; after this every connection uses our key. */
async function installKeyWithPassword(ip: string, pubKey: string): Promise<void> {
  const remote = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  const args = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
    '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1',
    `${config.guestUser}@${ip}`, remote,
  ];
  // Tcl braces quote each argument literally (nothing above contains a brace).
  const script = `
    set timeout 60
    spawn ${args.map((a) => `{${a}}`).join(' ')}
    expect {
      -re "(?i)password:" { send "${config.guestPassword}\r"; exp_continue }
      eof
    }
    lassign [wait] pid spawnid os_error exit_code
    exit $exit_code
  `;
  await run('expect', ['-c', script], { timeoutMs: 90_000 });
}
