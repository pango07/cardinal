# cardinal-agent

Run GitHub Actions jobs on a machine you own, one fresh environment per job. Two backends:

- **tart** (default): a fresh **macOS** VM per job on an Apple Silicon Mac. Xcode, simulators, `xcodebuild test`. Label `cardinal-macos`.
- **docker**: a fresh container from the public Cardinal runner image per job, on anything that runs Docker (Linux box, old laptop, a teammate's machine). Label `cardinal-docker`. Start it with `CARDINAL_BACKEND=docker node src/main.ts run --repo you/app`; no `prepare` step.

The rest of this page is about the macOS backend.

## macOS

Ephemeral **macOS** runners for GitHub Actions, on an Apple Silicon Mac you own. Same idea as the Linux side of Cardinal: a job is queued, a fresh VM boots, the runner inside claims that one job, runs it, and the VM is deleted. Xcode, simulators and `xcodebuild test` all work, because it's real macOS.

There is no macOS on Vercel Sandbox (or any Linux cloud), so this driver runs where macOS can legally run: Apple hardware. VMs come from [Tart](https://github.com/cirruslabs/tart), which uses Apple's Virtualization.framework, and the base image is cirruslabs' `macos-tahoe-xcode:26.4.1`.

```yaml
jobs:
  ios:
    runs-on: cardinal-macos
```

## How it differs from the Linux driver

| | Linux (`cardinal`, `cardinal-4x`, …) | macOS (`cardinal-macos`) |
|---|---|---|
| Compute | Vercel Sandbox microVMs, on demand | Tart VMs on your Mac |
| Triggered by | GitHub webhook → Vercel Function | This agent polling the GitHub API (every 10 s) |
| Concurrency | Plan quota (thousands) | **2 VMs per host** (Apple's limit) |
| Isolation | Fresh microVM per job | Fresh VM clone per job, deleted afterwards |
| Cost | Per second of CPU + memory | Your Mac's electricity |

Polling instead of a webhook because your Mac isn't reachable from the internet, and it keeps the setup to one process with no tunnel.

## Requirements

- Apple Silicon Mac, macOS 13+, **~100 GB free** (the Xcode image is 67 GB compressed), ideally 32 GB RAM for two concurrent VMs
- [Tart](https://github.com/cirruslabs/tart): `brew install cirruslabs/cli/tart`, or unpack the [release tarball](https://github.com/cirruslabs/tart/releases/latest/download/tart.tar.gz) and set `CARDINAL_TART=/path/to/tart.app/Contents/MacOS/tart`
- Node 22.18+ (runs TypeScript directly, no build step)
- `gh` logged in as someone with **admin** on the repos (or `GITHUB_TOKEN` with the same)

## Setup

```bash
cd agent
node src/main.ts prepare          # pulls the image (once, slow), boots it, installs our SSH key + actions/runner
                                  # + JDK 21 and the Android SDK (CARDINAL_MAC_ANDROID=0 to skip), shuts it down
node src/main.ts run --repo you/app --repo you/other-app
```

Leave `run` running. It sweeps leftover VMs at startup, and Ctrl-C waits for in-flight jobs. To make it a service that starts at login, restarts on failure and keeps the Mac awake while on power:

```bash
agent/install-service.sh you/app you/other-app     # launchd user agent; logs in ~/Library/Logs/cardinal-mac/
agent/install-service.sh --uninstall
```

## Configuration

| Env | Default | |
|---|---|---|
| `CARDINAL_MAC_IMAGE` | `ghcr.io/cirruslabs/macos-tahoe-xcode:26.4.1` | Source image. Other tags: `26.3`, `26.5`, `latest` |
| `CARDINAL_MAC_LABEL` | `cardinal-macos` | `runs-on` label this agent claims |
| `CARDINAL_MAC_CPU` / `CARDINAL_MAC_MEMORY_MB` | `8` / `16384` | Per VM |
| `CARDINAL_MAC_CONCURRENCY` | `2` | Max VMs at once (Apple allows 2) |
| `CARDINAL_MAC_TIMEOUT_MINUTES` | `60` | Max job length; the VM is stopped after this |
| `CARDINAL_MAC_IDLE_TIMEOUT_SECONDS` | `300` | Runner exits if no job arrives (the job was cancelled or taken by the other VM) |
| `CARDINAL_MAC_ANDROID` | `1` | Also install JDK 21 + Android SDK into the base, for Robolectric/Roborazzi jobs that must run on macOS |
| `CARDINAL_MAC_STATE` | `~/.cardinal/mac` | SSH key location |

## What's inside a job VM

Everything in the cirruslabs Xcode image (Xcode 26.4.1 at `/Applications/Xcode.app`, iOS simulator runtimes, Homebrew, Ruby, Flutter, …), plus `~/actions-runner`. The `admin` user has passwordless `sudo`. The VM is a clone of the base: a job can install anything and it's gone with the VM.

## Security

Jobs run as `admin` inside a VM with no access to the host filesystem. The host's only exposure is the network the VM is on (a NAT'd bridge). As with any self-hosted runner: **don't run fork pull requests on it** for a public repo.

## Limits

- 2 concurrent jobs per Mac. Run the agent on more Macs for more.
- VM boot to runner listening is about 20–30 s, slower than the Linux driver's 3 s.
- The Mac must be awake. The service wraps the agent in `caffeinate -s`, which prevents sleep while on AC power.

## Hosting it somewhere other than your laptop

The agent runs the same on any Apple Silicon macOS: a Mac mini on a shelf, or rented hardware (Scaleway Apple Silicon, AWS EC2 Mac, MacStadium). Install Tart, `node`, `gh` (or set `GITHUB_TOKEN`), clone this repo, `prepare`, `install-service.sh`. Two VMs per host; add hosts for more.
