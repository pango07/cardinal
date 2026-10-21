import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (name: string, fallback: string) => process.env[name] || fallback;

export type Backend = 'tart' | 'docker';

export const config = {
  /** tart: fresh macOS VM per job (Apple Silicon). docker: fresh container from the runner image per job (any OS). */
  backend: env('CARDINAL_BACKEND', 'tart') as Backend,
  /** Docker backend: image to run. The public Cardinal image works out of the box. */
  dockerImage: env('CARDINAL_DOCKER_IMAGE', 'vcr.vercel.com/jvaught01s-projects/cardinal/cardinal-runner:v0.3'),
  docker: env('CARDINAL_DOCKER', 'docker'),
  /** Tart binary. `brew install cirruslabs/cli/tart`, or the release tarball in ~/.local. */
  tart: env('CARDINAL_TART', 'tart'),
  stateDir: env('CARDINAL_MAC_STATE', join(homedir(), '.cardinal', 'mac')),
  /** Pulled once; `prepare` derives the base VM from it. */
  sourceImage: env('CARDINAL_MAC_IMAGE', 'ghcr.io/cirruslabs/macos-tahoe-xcode:26.4.1'),
  baseVm: env('CARDINAL_MAC_BASE', 'cardinal-mac-base'),
  /** Jobs opt in with `runs-on: cardinal-macos` (tart) or `runs-on: cardinal-docker` (docker). */
  label: env('CARDINAL_MAC_LABEL', process.env.CARDINAL_BACKEND === 'docker' ? 'cardinal-docker' : 'cardinal-macos'),
  runnerLabels: process.env.CARDINAL_BACKEND === 'docker' ? ['cardinal-docker', 'cardinal-agent'] : ['cardinal-macos', 'cardinal-agent', 'macos'],
  cpu: Number(env('CARDINAL_MAC_CPU', '8')),
  memoryMb: Number(env('CARDINAL_MAC_MEMORY_MB', '16384')),
  /** Apple's Virtualization.framework allows two VMs per host. */
  concurrency: Number(env('CARDINAL_MAC_CONCURRENCY', '2')),
  pollMs: Number(env('CARDINAL_MAC_POLL_SECONDS', '10')) * 1000,
  jobTimeoutMs: Number(env('CARDINAL_MAC_TIMEOUT_MINUTES', '60')) * 60_000,
  idleTimeoutMs: Number(env('CARDINAL_MAC_IDLE_TIMEOUT_SECONDS', '300')) * 1000,
  /** Also install JDK 21 + the Android SDK into the base VM, for Android jobs that must run on macOS (screenshot tests). */
  android: env('CARDINAL_MAC_ANDROID', '1') !== '0',
  androidPackages: env('CARDINAL_MAC_ANDROID_PACKAGES', 'platform-tools platforms;android-37.0 platforms;android-36 build-tools;36.1.0'),
  /** Guest login on cirruslabs images. Only used once, by `prepare`, to install our SSH key. */
  guestUser: env('CARDINAL_MAC_GUEST_USER', 'admin'),
  guestPassword: env('CARDINAL_MAC_GUEST_PASSWORD', 'admin'),
};

export const sshKeyPath = join(config.stateDir, 'id_ed25519');
export const vmPrefix = 'cardinal-mac-job-';
