# Platform Initialization (`init_pltf.sh`)

`init_pltf.sh` bootstraps a fresh Ubuntu server for OPCP-explorer:

- installs system dependencies, CLIs, Docker, Kata Containers and NVIDIA/MIG support
- clones the platform repository into its install folder
- prepares the Python environment

After it finishes, continue with [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) to start the platform.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| OS | Ubuntu 22.04+ (tested on OVHcloud instances) |
| User | A user with `sudo`. Running via `sudo` is supported: ownership of the clone, `~/.aws` and `~/deployments/admin` is handed back to the invoking user at the end. |
| Network | Internet access |
| Git access | Read access to `REPO_URL`. An SSH key for `SUBMODULE_URL` if it is an `git@` URL. |
| `conf/deploy.ini` | **Required.** The script aborts if it is missing. |
| GPU (optional) | NVIDIA H100 / A100 / A30 for MIG shared GPU |

## Quick start

From a checkout of the repository (or a folder containing `init_pltf.sh` and `conf/`):

```bash
cp conf/deploy.ini.template conf/deploy.ini
vi conf/deploy.ini            # set DOMAIN, LINUX_USER_INSTALLATION, S3_BUCKET_NAME, ...
chmod +x init_pltf.sh
./init_pltf.sh
```

The script asks five questions (press Enter to keep the default), then runs every install step. Each step prints `[OK]`, `[WARNING]` (non-blocking) or `[ERROR]`.

## Platform identity prompts

| Prompt | Variable | Effect |
|--------|----------|--------|
| Platform folder slug | `PLTF_FOLDER` | Clone directory name, container prefixes. It must be lowercase letters, digits and hyphens; an invalid value is asked again, or aborts if it came from the environment. |
| Platform display name | `PLTF_NAME` | Name shown in the UI and banners |
| Repository clone URL | `REPO_URL` | Source of the clone |
| Shared submodule URL | `SUBMODULE_URL` | Added as the `shared` submodule (holds `deployApp.sh` and the AI agent context files) |
| Install location (parent folder) | `INSTALL_DIR` | The repo is cloned into `<INSTALL_DIR>/<PLTF_FOLDER>`. Default `../`. |

Each default is resolved independently, in this order:

1. the environment variable, if it is set and non-empty;
2. the key in `conf/deploy.ini`;
3. a built-in fallback.

The fallbacks are `agentic-ai-plateform` for the folder and name, `https://github.com/Sam9682/agentic-ai-plateform.git`, `git@github.com:Sam9682/ai-swautomorph--shared.git`, and `../`.

### Non-interactive runs

Set the variables up front to skip the prompts. With no TTY, every unset value takes its default.

```bash
PLTF_FOLDER=acme-cloud \
PLTF_NAME="Acme Cloud Platform" \
REPO_URL=https://github.com/your-org/your-repo.git \
SUBMODULE_URL=git@github.com:your-org/shared.git \
INSTALL_DIR=/home/psmc \
./init_pltf.sh
```

> To use the default layout `/home/<LINUX_USER_INSTALLATION>/<PLTF_FOLDER>` that the rest of the platform expects, set `INSTALL_DIR` to `/home/<LINUX_USER_INSTALLATION>`.

## What the script does

| # | Step | Details |
|---|------|---------|
| 0 | Pre-checks | Requires `conf/deploy.ini`. Makes sure `/tmp` exists with mode `1777`. |
| 1 | System packages | `python3`, `python3-pip`, `python3-venv`, `net-tools`, `unzip` |
| 2 | CLIs | Amazon Kiro CLI (`cli.kiro.dev`), OVH `shai`, AWS CLI v2. Kiro and shai are the engines behind the AI agents (see [technicals/VIRTUAL_AGENTS.md](./technicals/VIRTUAL_AGENTS.md)). |
| 3 | Terraform | 1.14.5 into `/usr/local/bin` (falls back to `apt`) |
| 4 | Network | If netplan is present: public interface metric `50`, private `200` (backs up the netplan file first) |
| 5 | Docker | Docker Engine via `get.docker.com`, `docker-compose`, adds the user to the `docker` group |
| 6 | Kata Containers | Kata 3.32.0 static release into `/opt/kata`. Registers the `kata` runtime with the Docker daemon. |
| 7 | NVIDIA / MIG | `nvidia-driver-550`, `nvidia-smi -mig 1`, `nvidia-container-toolkit`, then a `docker run --gpus` test (30 s timeout). Every GPU step is non-blocking. |
| 8 | AWS profile | Writes `~/.aws/config` and `~/.aws/credentials` with a placeholder `OVH-SWAUTOMORPH` profile (endpoint `s3.gra.io.cloud.ovh.net`). **Overwrites existing files.** |
| 9 | Clone | `git clone REPO_URL <INSTALL_DIR>/<PLTF_FOLDER>`, adds the `shared` submodule, `submodule update --init --recursive` |
| 10 | Identity | Writes `PLTF_NAME` and `PLTF_FOLDER` into the clone's `conf/deploy.ini` |
| 11 | Python | `.venv` in the clone + `pip install -r requirements.txt` |
| 12 | Final | Creates `logs/`, makes `setup_modsecurity_config.sh` executable, creates `~/deployments/admin` |
| 13 | Ownership | When run under `sudo`, `chown -R` of the clone and home artifacts to the invoking user |

## After the script

1. **Complete the clone's `conf/deploy.ini`.** The new clone's `conf/deploy.ini` contains only `PLTF_NAME` and `PLTF_FOLDER`, because `deploy.ini` is not tracked in git. Copy in your other settings (`DOMAIN`, `LINUX_USER_INSTALLATION`, `S3_BUCKET_NAME`, ...):

   ```bash
   cd <INSTALL_DIR>/<PLTF_FOLDER>
   cat conf/deploy.ini.template      # reference
   vi conf/deploy.ini
   ```

2. **Add SSL certificates** inside the clone:

   ```bash
   mkdir -p ssl/<DOMAIN>
   # ssl/<DOMAIN>/fullchain_domain.crt
   # ssl/<DOMAIN>/privateKey_domain.key
   ```

   The script's closing message also creates an `ssl/<DOMAIN>` folder. That folder lands in the directory it ends in (`~/deployments`), not in the clone, so create the folder in the clone yourself. `scripts/generate_ssl.sh` and `scripts/setup_letsencrypt.sh` exist, but they do not write to `ssl/<DOMAIN>/`. Move their output there (see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md#ssl-certificates)).

3. **Set S3 credentials** in `~/.aws/credentials` (replace `XXX` / `YYY`):

   ```ini
   [OVH-SWAUTOMORPH]
   aws_access_key_id = YOUR_ACCESS_KEY
   aws_secret_access_key = YOUR_SECRET_KEY
   endpoint_url = https://s3.gra.io.cloud.ovh.net/
   signature_version = s3v4
   ```

4. **Apply the docker group**: log out and back in, or run `newgrp docker`.

5. **Start the platform**:

   ```bash
   source .venv/bin/activate
   python3 scripts/controller_cli.py start locally
   ```

## Verifying optional components

```bash
docker info | grep -i kata                      # kata runtime registered
docker run --runtime kata --rm hello-world      # kata works
nvidia-smi                                      # driver
nvidia-smi -L                                   # GPUs / MIG devices
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `conf/deploy.ini not found` | `cp conf/deploy.ini.template conf/deploy.ini`, edit, re-run |
| `Invalid slug` | Use lowercase letters, digits and hyphens only |
| Docker permission denied after install | `newgrp docker` or log out/in |
| Clone or submodule fails | Check `REPO_URL` / `SUBMODULE_URL` and your SSH key |
| Netplan step skipped | Normal without netplan; configure routing manually if needed |
| `aws` not found | Open a new shell |
| NVIDIA / MIG warnings | Expected on servers without a MIG-capable GPU; GPU features stay disabled |
| Docker GPU test fails | Check `nvidia-smi` on the host first |

## Tests

`tests/bash/` contains unit, property and integration tests for the script: ownership restore, identity resolution and preservation. See [technicals/TESTING.md](./technicals/TESTING.md).
