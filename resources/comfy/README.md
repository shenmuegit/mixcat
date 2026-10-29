# Managed ComfyUI runtime

This Windows x64 combination uses the full official ComfyUI frontend served by the pinned local backend in CPU mode. `runtime-manifest.json` records the source commit, interpreter distribution, and each exact wheel URL and SHA-256. `requirements-win-x64.lock` is hash-bound to the manifest. Preparation never resolves latest versions.

Run from Mixcat's checkout with Node 24+ and Git available:

```powershell
./scripts/dev.ps1 prepare-comfy G:/path/to/project
```

The project must already exist on a local non-C drive. Interpreter, virtual environment, independent backend checkout, verified downloads, logs, caches, and writable Comfy data all live under that project's `.mixcat/comfy/`. Input, output, models, temp, user settings and custom nodes are under `data/`. The backend's LICENSE and the interpreter's license remain in their official distributions.

Child processes inherit an explicit OS/network/TLS environment allowlist. Proxy and certificate settings remain available, loopback stays direct, and host API credentials are excluded. Python starts from the owned backend checkout; its home, user profile, AppData, XDG paths and caches are project-local. The generated instance UUID is available to the owned extension as `MIXCAT_COMFY_INSTANCE_ID`.

Python uses CPython's documented offline install route: extract the full standard runtime ZIP from its official Windows release manifest and create a virtual environment with `python -m venv`. This is the standard GIL build, not the embeddable distribution. Python 3.13.18 has no official Windows binaries; this combination uses the current secure official Python 3.14.10 distribution. Packages install exclusively from verified local wheels with `--no-index --require-hashes`, followed by `pip check` and exact installed-version/CPU checks.

Backend preparation clones the official Git repository and checks out the complete pinned commit. For development, `MIXCAT_COMFY_BACKEND_SOURCE` can point to a read-only checkout inside the target project; preparation creates an independent `--no-hardlinks` clone with no alternates, sets its origin to the official repository and verifies its HEAD and clean tracked source. Existing active runtime files are not upgraded in place.

`ready.json` is published atomically after installation and verification. `ComfyRuntime.start` then checks actual backend/core-node/extensions/frontend resources before returning an instance. Its loopback port is chosen without adopting another server. `stop` refuses a nonempty or unverifiable queue. The service owner must close new admissions before stopping so another submit cannot race the idle check.

On Windows, the virtual environment executable redirects to a separate interpreter process. Termination therefore ends the owned idle process tree with `taskkill /T /F`, including the redirector's interpreter; it does not target a process discovered from an occupied port.

An existing `instance.lock` blocks automatic adoption after an owner crash; recover the recorded process/queue before removing its stale lock. The runtime never terminates a process merely because it owns a recorded port or PID.

Sources: [ComfyUI manual installation](https://github.com/Comfy-Org/ComfyUI/tree/v0.43.0#manual-install-windows-linux), [CPython offline installs](https://docs.python.org/3/using/windows.html#offline-installs), [Python 3.14.10](https://www.python.org/downloads/release/python-31410/), [official Windows distribution manifest](https://www.python.org/ftp/python/3.14.10/windows-3.14.10.json), [PyTorch CPU wheels](https://download.pytorch.org/whl/cpu/torch/).
